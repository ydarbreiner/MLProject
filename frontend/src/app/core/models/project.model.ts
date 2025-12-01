import { PointCloud } from './point-cloud.model';

export interface ProjectLocation {
  lat: number;
  lng: number;
}

export interface ProjectFile {
  id: number;
  projectId: number;
  originalFilename: string;
  storedFilename: string;
  contentType?: string | null;
  size: number;
  description?: string | null;
  uploadedAt?: string | null;
  downloadUrl: string;
}

export interface ProjectPole {
  lat: number;
  lng: number;
  name?: string | null;
  alt?: number | null;
}

export interface ProjectSummary {
  id: number;
  name: string;
  description?: string | null;
  geometry?: Record<string, unknown> | null;
  centroid?: ProjectLocation | null;
  metadata?: Record<string, unknown> | null;
  pointCloudCount: number;
  fileCount: number;
  totalFileSize: number;
  poleCount: number;
  poles?: ProjectPole[];
  createdAt?: string | null;
  updatedAt?: string | null;
}

export interface ProjectDetail extends ProjectSummary {
  files: ProjectFile[];
  pointClouds: PointCloud[];
  poles: ProjectPole[];
}

export interface ProjectUploadParseSummary {
  totalFeatures: number;
  poleCount: number;
  centroidUpdated: boolean;
  geometryUpdated: boolean;
}

export interface ProjectUploadResponse {
  file: ProjectFile;
  project: ProjectDetail;
  parseSummary?: ProjectUploadParseSummary;
  parseError?: string;
}

export interface ProjectRequest {
  name: string;
  description?: string | null;
  geometry?: Record<string, unknown> | null;
  centroid?: ProjectLocation | null;
  metadata?: Record<string, unknown> | null;
}

export type ProjectUpdateRequest = Partial<ProjectRequest>;
