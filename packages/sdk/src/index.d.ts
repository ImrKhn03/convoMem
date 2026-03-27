export interface ConvoMemConfig {
  apiKey: string;
  baseUrl?: string;
  timeout?: number;
  maxRetries?: number;
  retryDelay?: number;
}

export interface Message {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

export interface CaptureOptions {
  platform?: string;
  filters?: { pii?: boolean };
}

export interface CaptureResult {
  status: string;
  captureId: string;
}

export interface LookupResult {
  context: string;
  memories: Memory[];
  tokenCount: number;
  scores?: Record<string, number>;
}

export interface Memory {
  id: string;
  content: string;
  topicKey?: string;
  category?: string;
  memoryType?: string;
  durability?: number;
  confidence?: number;
  importance?: number;
  confirmationCount?: number;
  isSensitive?: boolean;
  platform?: string;
  sourceContext?: string;
  searchTags?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface SearchResult {
  results: Array<{ id: string; score: number; payload?: Record<string, unknown> }>;
  count: number;
}

export interface MemoryListResult {
  memories: Memory[];
  total: number;
  page: number;
  pages: number;
}

export interface AddMemoryOptions {
  category?: string;
  memoryType?: string;
  topicKey?: string;
  platform?: string;
}

export interface UpdateMemoryData {
  content?: string;
  category?: string;
  memoryType?: string;
  topicKey?: string;
  importance?: number;
  isSensitive?: boolean;
}

export interface FeedbackData {
  memoryIds: string[];
  wasHelpful: boolean;
  topic?: string;
  scores?: Record<string, number>;
}

export interface Entity {
  id: string;
  userId: string;
  name: string;
  aliases: string[];
  entityType: string;
  description?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface Relationship {
  id: string;
  userId: string;
  fromEntityId: string;
  toEntityId: string;
  relationType: string;
  confidence: number;
  sourceMemoryId?: string;
  fromEntity?: Pick<Entity, 'id' | 'name' | 'entityType'>;
  toEntity?: Pick<Entity, 'id' | 'name' | 'entityType'>;
  createdAt?: string;
  updatedAt?: string;
}

export interface GraphResult {
  entities: Entity[];
  relationships: Relationship[];
}

export interface EntityListResult {
  entities: Entity[];
  total: number;
  page: number;
  pages: number;
}

declare class ConvoMem {
  constructor(config: ConvoMemConfig);

  capture(messages: Message[], opts?: CaptureOptions): Promise<CaptureResult>;
  lookup(topic: string): Promise<LookupResult>;
  search(query: string, opts?: { limit?: number }): Promise<SearchResult>;
  listMemories(opts?: { page?: number; limit?: number }): Promise<MemoryListResult>;
  getMemory(id: string): Promise<Memory>;
  deleteMemory(id: string): Promise<null>;
  addMemory(content: string, opts?: AddMemoryOptions): Promise<Memory>;
  updateMemory(id: string, data: UpdateMemoryData): Promise<Memory>;
  waitForCapture(
    captureId: string,
    opts?: { pollIntervalMs?: number; timeoutMs?: number }
  ): Promise<{ captureId: string; status: string; count: number; memories: Memory[] }>;
  lookupFeedback(data: FeedbackData): Promise<{ success: boolean; count?: number }>;

  listEntities(opts?: { page?: number; limit?: number; entityType?: string }): Promise<EntityListResult>;
  getEntity(id: string): Promise<Entity>;
  searchEntities(query: string, limit?: number): Promise<{ entities: Entity[] }>;
  getGraph(opts?: { entityId?: string; depth?: number }): Promise<GraphResult>;
  deleteEntity(id: string): Promise<null>;
}

export default ConvoMem;
export { ConvoMem };
