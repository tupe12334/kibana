/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { loggingSystemMock } from '@kbn/core-logging-server-mocks';
import type { SmlListItem } from '@kbn/agent-builder-plugin/server';
import { AttachmentType } from '@kbn/agent-builder-common/attachments';
import { createConnectorSmlType } from './connector';

const WORKFLOW_YAML_WITH_TAG = `
name: test.workflow
description: A test workflow tool
tags:
  - agent-builder-tool
steps:
  - id: step1
    type: action
`;

const WORKFLOW_YAML_WITHOUT_TAG = `
name: test.other
description: Not an AB tool
tags:
  - some-other-tag
steps:
  - id: step1
    type: action
`;

jest.mock('@kbn/connector-specs', () => ({
  getConnectorSpec: jest.fn(),
  getWorkflowTemplatesForConnector: jest.fn(),
}));

const { getConnectorSpec, getWorkflowTemplatesForConnector } =
  jest.requireMock('@kbn/connector-specs');

const mockSavedObjectsClient = {
  createPointInTimeFinder: jest.fn(),
  get: jest.fn(),
};

const mockToolRegistry = {
  list: jest.fn(),
};

const mockGetToolRegistry = jest.fn().mockResolvedValue(mockToolRegistry);
const mockGetActionSavedObjectsClient = jest.fn().mockResolvedValue(mockSavedObjectsClient);

const createContext = () => ({
  logger: loggingSystemMock.createLogger(),
});

const createAttachmentContext = () => ({
  request: {} as never,
  spaceId: 'default',
});

async function collectPages(iterable: AsyncIterable<SmlListItem[]>): Promise<SmlListItem[]> {
  const items: SmlListItem[] = [];
  for await (const page of iterable) {
    items.push(...page);
  }
  return items;
}

describe('connectorSmlType', () => {
  const connectorSmlType = createConnectorSmlType({
    getToolRegistry: mockGetToolRegistry,
    getActionSavedObjectsClient: mockGetActionSavedObjectsClient,
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('id', () => {
    it('equals connector', () => {
      expect(connectorSmlType.id).toBe('connector');
    });
  });

  describe('fetchFrequency', () => {
    it('returns 24h (safety-net crawl; primary indexing is event-driven)', () => {
      expect(connectorSmlType.fetchFrequency!()).toBe('24h');
    });
  });

  describe('list', () => {
    it('only yields connectors with agent-builder-tool tagged workflow templates', async () => {
      getWorkflowTemplatesForConnector.mockImplementation((typeId: string) => {
        if (typeId === '.mcp') return [WORKFLOW_YAML_WITH_TAG];
        if (typeId === '.slack2') return [WORKFLOW_YAML_WITHOUT_TAG];
        return [];
      });

      const savedObjects = [
        {
          id: 'conn-1',
          type: 'action',
          attributes: { actionTypeId: '.mcp', name: 'My MCP' },
          references: [],
          updated_at: '2024-01-01T00:00:00Z',
          namespaces: ['default'],
        },
        {
          id: 'conn-2',
          type: 'action',
          attributes: { actionTypeId: '.slack2', name: 'Slack' },
          references: [],
          updated_at: '2024-01-02T00:00:00Z',
          namespaces: ['default'],
        },
        {
          id: 'conn-3',
          type: 'action',
          attributes: { actionTypeId: '.email', name: 'Email' },
          references: [],
          updated_at: '2024-01-03T00:00:00Z',
          namespaces: ['default'],
        },
      ];

      const closeMock = jest.fn();
      mockSavedObjectsClient.createPointInTimeFinder.mockReturnValue({
        async *find() {
          yield { saved_objects: savedObjects };
        },
        close: closeMock,
      });

      const result = await collectPages(connectorSmlType.list(createContext() as never));

      expect(result).toEqual([
        {
          id: 'conn-1',
          updatedAt: '2024-01-01T00:00:00Z',
          spaces: ['default'],
        },
      ]);
      expect(closeMock).toHaveBeenCalled();
    });

    it('skips connectors without workflow templates', async () => {
      getWorkflowTemplatesForConnector.mockReturnValue([]);

      const savedObjects = [
        {
          id: 'conn-1',
          type: 'action',
          attributes: { actionTypeId: '.email', name: 'Email' },
          references: [],
          updated_at: '2024-01-01T00:00:00Z',
          namespaces: ['default'],
        },
      ];

      const closeMock = jest.fn();
      mockSavedObjectsClient.createPointInTimeFinder.mockReturnValue({
        async *find() {
          yield { saved_objects: savedObjects };
        },
        close: closeMock,
      });

      const result = await collectPages(connectorSmlType.list(createContext() as never));

      expect(result).toEqual([]);
      expect(closeMock).toHaveBeenCalled();
    });

    it('closes PIT finder even when an error occurs', async () => {
      const closeMock = jest.fn();
      mockSavedObjectsClient.createPointInTimeFinder.mockReturnValue({
        async *find() {
          throw new Error('PIT error');
        },
        close: closeMock,
      });

      await expect(collectPages(connectorSmlType.list(createContext() as never))).rejects.toThrow(
        'PIT error'
      );
      expect(closeMock).toHaveBeenCalled();
    });

    it('defaults updatedAt to current date when so.updated_at is undefined', async () => {
      getWorkflowTemplatesForConnector.mockReturnValue([WORKFLOW_YAML_WITH_TAG]);

      const savedObjects = [
        {
          id: 'conn-1',
          type: 'action',
          attributes: { actionTypeId: '.mcp', name: 'MCP' },
          references: [],
          updated_at: undefined,
          namespaces: ['default'],
        },
      ];

      mockSavedObjectsClient.createPointInTimeFinder.mockReturnValue({
        async *find() {
          yield { saved_objects: savedObjects };
        },
        close: jest.fn(),
      });

      const result = await collectPages(connectorSmlType.list(createContext() as never));

      expect(result).toHaveLength(1);
      expect(result[0].updatedAt).toBeDefined();
      expect(new Date(result[0].updatedAt).getTime()).not.toBeNaN();
    });

    it('defaults spaces to [] when so.namespaces is undefined', async () => {
      getWorkflowTemplatesForConnector.mockReturnValue([WORKFLOW_YAML_WITH_TAG]);

      const savedObjects = [
        {
          id: 'conn-1',
          type: 'action',
          attributes: { actionTypeId: '.mcp', name: 'MCP' },
          references: [],
          updated_at: '2024-01-01T00:00:00Z',
          namespaces: undefined,
        },
      ];

      mockSavedObjectsClient.createPointInTimeFinder.mockReturnValue({
        async *find() {
          yield { saved_objects: savedObjects };
        },
        close: jest.fn(),
      });

      const result = await collectPages(connectorSmlType.list(createContext() as never));

      expect(result).toEqual([{ id: 'conn-1', updatedAt: '2024-01-01T00:00:00Z', spaces: [] }]);
    });
  });

  describe('getSmlData', () => {
    it('returns chunk with connector name, description, and tool descriptions in content', async () => {
      mockSavedObjectsClient.get.mockResolvedValue({
        id: 'conn-1',
        type: 'action',
        attributes: { name: 'My MCP Connector', actionTypeId: '.mcp' },
        references: [],
      });

      getConnectorSpec.mockReturnValue({
        metadata: {
          id: '.mcp',
          displayName: 'MCP',
          description: 'Model Context Protocol connector',
        },
      });

      getWorkflowTemplatesForConnector.mockReturnValue([
        WORKFLOW_YAML_WITH_TAG,
        WORKFLOW_YAML_WITHOUT_TAG,
      ]);

      const result = await connectorSmlType.getSmlData!('conn-1', createContext() as never);

      expect(mockSavedObjectsClient.get).toHaveBeenCalledWith('action', 'conn-1');
      expect(result).toEqual({
        chunks: [
          {
            type: 'connector',
            title: 'My MCP Connector',
            content:
              'My MCP Connector\nMCP\nModel Context Protocol connector\nA test workflow tool',
            permissions: ['action:execute'],
          },
        ],
      });
    });

    it('returns undefined on error and logs warning', async () => {
      mockSavedObjectsClient.get.mockRejectedValue(new Error('Not found'));
      const context = createContext();

      const result = await connectorSmlType.getSmlData!('missing-conn', context as never);

      expect(result).toBeUndefined();
      expect(context.logger.warn).toHaveBeenCalledWith(
        expect.stringContaining("failed to get data for 'missing-conn'")
      );
    });

    it('handles missing optional fields gracefully', async () => {
      mockSavedObjectsClient.get.mockResolvedValue({
        id: 'conn-1',
        type: 'action',
        attributes: { name: 'Basic Connector', actionTypeId: '.unknown' },
        references: [],
      });

      getConnectorSpec.mockReturnValue(undefined);
      getWorkflowTemplatesForConnector.mockReturnValue([WORKFLOW_YAML_WITH_TAG]);

      const result = await connectorSmlType.getSmlData!('conn-1', createContext() as never);

      expect(result!.chunks[0]).toEqual({
        type: 'connector',
        title: 'Basic Connector',
        content: 'Basic Connector\n.unknown\nA test workflow tool',
        permissions: ['action:execute'],
      });
    });
  });

  describe('toAttachment', () => {
    it('returns connector attachment with correct shape and tools filtered by connector tag', async () => {
      mockSavedObjectsClient.get.mockResolvedValue({
        id: 'conn-1',
        type: 'action',
        attributes: { name: 'My MCP Connector', actionTypeId: '.mcp' },
        references: [],
      });

      mockToolRegistry.list.mockResolvedValue([
        {
          id: 'mcp.my-mcp.search',
          type: 'workflow',
          description: 'Search tool',
          readonly: false,
          tags: ['connector', 'mcp', 'connector:conn-1'],
          configuration: { workflow_id: 'wf-1' },
        },
        {
          id: 'mcp.my-mcp.fetch',
          type: 'workflow',
          description: 'Fetch tool',
          readonly: false,
          tags: ['connector', 'mcp', 'connector:conn-1'],
          configuration: { workflow_id: 'wf-2' },
        },
        {
          id: 'other.tool',
          type: 'workflow',
          description: 'Unrelated tool',
          readonly: false,
          tags: ['connector', 'other', 'connector:conn-99'],
          configuration: { workflow_id: 'wf-other' },
        },
      ]);

      const result = await connectorSmlType.toAttachment!(
        { origin_id: 'conn-1' } as never,
        createAttachmentContext() as never
      );

      expect(result).toEqual({
        type: AttachmentType.connector,
        data: {
          connector_id: 'conn-1',
          connector_name: 'My MCP Connector',
          connector_type: '.mcp',
          tools: [
            {
              id: 'mcp.my-mcp.search',
              description: 'Search tool',
              configuration: { workflow_id: 'wf-1' },
            },
            {
              id: 'mcp.my-mcp.fetch',
              description: 'Fetch tool',
              configuration: { workflow_id: 'wf-2' },
            },
          ],
        },
      });
    });

    it('returns undefined when connector is not found', async () => {
      mockSavedObjectsClient.get.mockRejectedValue(new Error('Not found'));

      const result = await connectorSmlType.toAttachment!(
        { origin_id: 'missing-conn' } as never,
        createAttachmentContext() as never
      );

      expect(result).toBeUndefined();
    });

    it('returns attachment with empty tools when no tools match the connector tag', async () => {
      mockSavedObjectsClient.get.mockResolvedValue({
        id: 'conn-1',
        type: 'action',
        attributes: { name: 'My Connector', actionTypeId: '.mcp' },
        references: [],
      });

      mockToolRegistry.list.mockResolvedValue([
        {
          id: 'other.tool',
          type: 'workflow',
          description: 'Unrelated',
          readonly: false,
          tags: ['connector:conn-99'],
          configuration: { workflow_id: 'wf-other' },
        },
      ]);

      const result = await connectorSmlType.toAttachment!(
        { origin_id: 'conn-1' } as never,
        createAttachmentContext() as never
      );

      expect(result).toEqual({
        type: AttachmentType.connector,
        data: {
          connector_id: 'conn-1',
          connector_name: 'My Connector',
          connector_type: '.mcp',
          tools: [],
        },
      });
    });

    it('uses the correct tool registry scoped to request', async () => {
      mockSavedObjectsClient.get.mockResolvedValue({
        id: 'conn-1',
        type: 'action',
        attributes: { name: 'Conn', actionTypeId: '.mcp' },
        references: [],
      });
      mockToolRegistry.list.mockResolvedValue([]);

      const attachmentContext = createAttachmentContext();
      await connectorSmlType.toAttachment!(
        { origin_id: 'conn-1' } as never,
        attachmentContext as never
      );

      expect(mockGetToolRegistry).toHaveBeenCalledWith(attachmentContext.request);
    });
  });
});
