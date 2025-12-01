export interface ClusterJobSummary {
  runName: string;
  jobName: string;
  createdAt: string;
  clusters: number;
  inertia: number;
  iterations: number;
  summaryPath: string;
  hasOverlays: boolean;
}

export interface ClusterJobDetail extends ClusterJobSummary {
  counts: Array<{ cluster: number; count: number }>;
  fileCounts: Array<{ filePath: string; count: number }>;
  embeddingsFile: string;
  overlays?: ClusterOverlayManifestItem[];
}

export interface ClusterOverlayManifest {
  runName: string;
  clusterJob: string;
  createdAt: string;
  pointclouds: ClusterOverlayManifestItem[];
}

export interface ClusterOverlayManifestItem {
  pointcloudId: number;
  overlayName: string;
  overlayPath: string;
  pointCount: number;
  tileCount: number;
  clusterCounts: Record<number, number>;
}

export interface ClusterOverlayPayload {
  pointcloudId: number;
  runName: string;
  clusterJob: string;
  filePath: string;
  overrides: Record<string, Record<string, number>>;
  clusterCounts: Record<number, number>;
  tileCount: number;
  pointCount: number;
}

export interface CreateClusterJobRequest {
  numClusters?: number;
  maxTrainingSteps?: number;
  patchesPerFile?: number;
  checkpointPath?: string | null;  // If provided, skip training and use this model
  targetCoverage?: number;  // Target coverage percentage (25, 50, 75, 90)
}

export interface TrainedModel {
  runName: string;
  checkpointPath: string;
  createdAt: string;
  configPath: string | null;
  config?: TrainingConfig | null;
  trainingGraphs?: TrainingGraphs | null;
}

export interface TrainingGraphs {
  loss?: string;
  lr?: string;
  delta?: string;
  best?: string;
}

export interface TrainingConfig {
  pointcloud_dir?: string;
  output_dir?: string;
  run_name?: string;
  patches_per_file?: number;
  patch_size?: number;
  patch_radius?: number;
  batch_size?: number;
  max_steps?: number;
  log_every?: number;
  checkpoint_every?: number;
  learning_rate?: number;
  weight_decay?: number;
  temperature?: number;
  jitter_std?: number;
  jitter_clip?: number;
  dropout_ratio?: number;
  scale_jitter?: number;
  use_intensity?: boolean;
  num_workers?: number;
  force_cpu?: boolean;
  embedding_dim?: number;
  projection_dim?: number;
  chunk_size_points?: number;
  max_chunk_attempts?: number;
  max_files_per_epoch?: number;
}

export interface ClusterGenerationJob {
  id: string;
  pointcloudId: number;
  status: 'queued' | 'training' | 'extracting' | 'clustering' | 'building_overlay' | 'completed' | 'failed' | 'cancelled';
  runName: string;
  clusterJobName: string | null;
  numClusters: number;
  maxTrainingSteps: number;
  currentStep: number;
  totalSteps: number | null;
  progressMessage: string | null;
  overlayPath: string | null;
  errorDetails: any | null;
  workerTaskId: string | null;
  receivedAt: string;
  updatedAt: string;
  completedAt: string | null;
}
