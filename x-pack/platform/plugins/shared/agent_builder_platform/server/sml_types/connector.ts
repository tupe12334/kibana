/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { parse } from 'yaml';
import type { KibanaRequest } from '@kbn/core-http-server';
import type { SavedObjectsClientContract } from '@kbn/core-saved-objects-api-server';
import type { SmlTypeDefinition } from '@kbn/agent-builder-plugin/server';
import type { ToolRegistry } from '@kbn/agent-builder-server';
import type { ConnectorAttachmentData } from '@kbn/agent-builder-common/attachments';
import { AttachmentType } from '@kbn/agent-builder-common/attachments';
import { getConnectorSpec, getWorkflowTemplatesForConnector } from '@kbn/connector-specs';

const CONNECTOR_SML_TYPE = 'connector';
const CONNECTOR_TAG_PREFIX = 'connector:';

interface ConnectorSmlTypeDeps {
  getToolRegistry: (request: KibanaRequest) => Promise<ToolRegistry>;
  /**
   * Returns a saved objects client that can read hidden `action` saved objects.
   * The standard scoped client and default internal repository cannot access
   * hidden types, so this factory creates one with `includedHiddenTypes: ['action']`.
   */
  getActionSavedObjectsClient: () => Promise<SavedObjectsClientContract>;
}

/**
 * Checks whether a workflow YAML template has the `agent-builder-tool` tag.
 */
const hasAgentBuilderToolTag = (yamlTemplate: string): boolean => {
  try {
    const parsed = parse(yamlTemplate);
    return parsed?.tags?.includes('agent-builder-tool') ?? false;
  } catch {
    return false;
  }
};

/**
 * Extracts a human-readable description from a workflow YAML template.
 */
const extractToolDescription = (yamlTemplate: string): string | undefined => {
  try {
    const parsed = parse(yamlTemplate);
    return typeof parsed?.description === 'string' ? parsed.description : undefined;
  } catch {
    return undefined;
  }
};

/**
 * Creates the SML type definition for connectors.
 *
 * Connectors with `agentBuilderWorkflows` (that have the `agent-builder-tool` tag)
 * are indexed into the SML so they can be discovered via `sml_search`.
 *
 * A factory function is used because `toAttachment()` needs access to the tool
 * registry, which requires a scoped request not available in the `SmlToAttachmentContext`.
 */
export const createConnectorSmlType = (deps: ConnectorSmlTypeDeps): SmlTypeDefinition => {
  const { getToolRegistry, getActionSavedObjectsClient } = deps;

  return {
    id: CONNECTOR_SML_TYPE,
    // Connectors are indexed via event-driven calls in the connector lifecycle
    // handler (onPostCreate / onPostDelete), so frequent crawling is unnecessary.
    // The crawler runs as a safety net to catch any missed events.
    fetchFrequency: () => '24h',

    async *list(_context) {
      const soClient = await getActionSavedObjectsClient();
      const finder = soClient.createPointInTimeFinder({
        type: 'action',
        perPage: 1000,
        namespaces: ['*'],
        fields: ['actionTypeId', 'name'],
      });

      try {
        for await (const response of finder.find()) {
          const items = response.saved_objects.filter((so) => {
            const actionTypeId = (so.attributes as { actionTypeId?: string }).actionTypeId;
            if (!actionTypeId) return false;

            const templates = getWorkflowTemplatesForConnector(actionTypeId);
            return templates.length > 0 && templates.some(hasAgentBuilderToolTag);
          });

          if (items.length > 0) {
            yield items.map((so) => ({
              id: so.id,
              updatedAt: so.updated_at ?? new Date().toISOString(),
              spaces: so.namespaces ?? [],
            }));
          }
        }
      } finally {
        await finder.close();
      }
    },

    getSmlData: async (originId, context) => {
      try {
        const soClient = await getActionSavedObjectsClient();
        const so = await soClient.get('action', originId);
        const attrs = so.attributes as { name?: string; actionTypeId?: string };
        const name = attrs.name ?? originId;
        const actionTypeId = attrs.actionTypeId ?? '';

        const spec = getConnectorSpec(actionTypeId);
        const displayName = spec?.metadata.displayName ?? actionTypeId;
        const description = spec?.metadata.description ?? '';

        const templates = getWorkflowTemplatesForConnector(actionTypeId);
        const toolDescriptions = templates
          .filter(hasAgentBuilderToolTag)
          .map(extractToolDescription)
          .filter((d): d is string => !!d);

        const contentParts = [name, displayName, description, ...toolDescriptions].filter(Boolean);

        return {
          chunks: [
            {
              type: CONNECTOR_SML_TYPE,
              title: name,
              content: contentParts.join('\n'),
              permissions: ['action:execute'],
            },
          ],
        };
      } catch (error) {
        context.logger.warn(
          `SML connector: failed to get data for '${originId}': ${(error as Error).message}`
        );
        return undefined;
      }
    },

    toAttachment: async (item, context) => {
      try {
        const soClient = await getActionSavedObjectsClient();
        const so = await soClient.get('action', item.origin_id);
        const attrs = so.attributes as { name?: string; actionTypeId?: string };
        const connectorName = attrs.name ?? item.origin_id;
        const connectorType = attrs.actionTypeId ?? '';

        const toolRegistry = await getToolRegistry(context.request);
        const allTools = await toolRegistry.list();
        const connectorTag = `${CONNECTOR_TAG_PREFIX}${item.origin_id}`;
        const connectorTools = allTools.filter(
          (tool) => tool.tags && tool.tags.includes(connectorTag)
        );

        const tools: ConnectorAttachmentData['tools'] = connectorTools.map((tool) => ({
          id: tool.id,
          description: tool.description,
          configuration: {
            workflow_id: (tool.configuration as Record<string, unknown>)?.workflow_id as string,
          },
        }));

        const data: ConnectorAttachmentData = {
          connector_id: item.origin_id,
          connector_name: connectorName,
          connector_type: connectorType,
          tools,
        };

        return {
          type: AttachmentType.connector,
          data: data as unknown as Record<string, unknown>,
        };
      } catch (error) {
        return undefined;
      }
    },
  };
};
