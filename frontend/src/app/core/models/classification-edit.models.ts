export interface ClassificationEditPoint {
  tileKey: string;
  pointIndex: number;
  sourceId?: string;
  unstable?: boolean;
}

export interface ClassificationEditOperationMetadata {
  selectionMode?: 'lasso' | 'brush' | 'box' | 'direct';
  totalSelected?: number;
  polygonVertices?: number;
  viewport?: { width: number; height: number };
  unstableIdentifiers?: number;
}

export interface ClassificationEditOperation {
  newClass: number;
  previousClass?: number | null;
  points: ClassificationEditPoint[];
  metadata?: ClassificationEditOperationMetadata;
}

export interface ClassificationEditRequest {
  operations: ClassificationEditOperation[];
  clientTimestamp: string;
  note?: string;
}

export interface ClassificationEditResponse {
  operationId: string;
  status: ClassificationEditStatus;
  acceptedPoints: number;
}

export interface ClassificationEditStatusResponse {
  operationId: string;
  status: ClassificationEditStatus;
  totalPoints: number;
  pointsProcessed: number;
  tilesTotal: number;
  tilesProcessed: number;
  unstableCount: number;
  receivedAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export type ClassificationEditStatus = 'queued' | 'processing' | 'completed' | 'failed';
