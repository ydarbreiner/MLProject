export interface PointCloudBoundsCorner {
  x?: number | null;
  y?: number | null;
  z?: number | null;
}

export interface PointCloudBoundsGeographicCorner {
  lat: number;
  lng: number;
}

export interface PointCloudBounds {
  min: PointCloudBoundsCorner;
  max: PointCloudBoundsCorner;
  geographic?: {
    southWest?: PointCloudBoundsGeographicCorner;
    northEast?: PointCloudBoundsGeographicCorner;
  };
  coordinateSystem?: string | null;
}

export type PointCloudFootprint =
  | {
      type: 'Polygon';
      coordinates: number[][][];
    }
  | {
      type: 'MultiPolygon';
      coordinates: number[][][][]; // nested array structure per GeoJSON spec
    };

export interface PointCloud {
    id: number;
    name: string;
    url: string;
    size: number;
    date: string;
    status?: 'processing' | 'completed' | 'failed';
    pointCount?: number;
    fileSize?: number;
    classification?: { [key: string]: number };

    // Phase 1: Essential Spatial Data
    bounds?: PointCloudBounds;
    footprint?: PointCloudFootprint | null;
    coverageAreaKm2?: number;
    coverageAreaSqft?: number;
    pointDensityPerM2?: number;

    // Quality Assessment
    qualityScore?: number; // 0-100
    classificationCompleteness?: number; // 0-100 percentage
    returnDistribution?: {
      first: number;
      intermediate: number;
      last: number;
      single: number;
    };

    // Project Management
    projectId?: number | null;
    acquisitionDate?: string;
    project?: string;
    location?: string;
    coordinateSystem?: string; // e.g., "UTM 13N (EPSG:32613)"
    errorMessage?: string | null;

    // Processing Pipeline
    processingStage?: 'raw' | 'filtered' | 'classified' | 'products';
    availableProducts?: string[];
  }

export interface PointCloudPolePosition {
  x: number;
  y: number;
  z: number | null;
}

export interface PointCloudPolePositionOverride extends PointCloudPolePosition {
  lat?: number | null;
  lng?: number | null;
  alt?: number | null;
  source?: string | null;
  updatedAt?: string | null;
}

export interface PointCloudPole {
  id: number | string;
  name?: string | null;
  lat: number;
  lng: number;
  alt?: number | null;
  position?: PointCloudPolePosition | null;
  positionSource?: 'transformer' | 'geographic-bounds' | string | null;
  positionOverride?: PointCloudPolePositionOverride | null;
}

export interface PointCloudPolesResponse {
  pointcloudId: number;
  projectId: number | null;
  coordinateSystem?: string | null;
  poles: PointCloudPole[];
}

export interface PointCloudPoleUpdateRequest {
  name?: string | null;
  lat?: number | null;
  lng?: number | null;
  alt?: number | null;
  position?: {
    x: number;
    y: number;
    z?: number | null;
  };
}
