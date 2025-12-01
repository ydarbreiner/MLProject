import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import {
  ClusterJobSummary,
  ClusterJobDetail,
  ClusterOverlayManifest,
  ClusterOverlayPayload,
  CreateClusterJobRequest,
  ClusterGenerationJob,
  TrainedModel,
} from '../models/cluster-analysis.models';
import { ApiService } from './api.service';

@Injectable({ providedIn: 'root' })
export class ClusterAnalysisService {
  private readonly baseUrl: string;

  constructor(private http: HttpClient, private api: ApiService) {
    this.baseUrl = `${this.api.getApiUrl()}/analysis`;
  }

  listClusterJobs(): Observable<ClusterJobSummary[]> {
    return this.http.get<ClusterJobSummary[]>(`${this.baseUrl}/cluster-jobs`);
  }

  getClusterJobDetail(runName: string, jobName: string): Observable<ClusterJobDetail> {
    return this.http.get<ClusterJobDetail>(`${this.baseUrl}/cluster-jobs/${runName}/${jobName}`);
  }

  getOverlayManifest(runName: string, jobName: string): Observable<ClusterOverlayManifest> {
    return this.http.get<ClusterOverlayManifest>(`${this.baseUrl}/cluster-jobs/${runName}/${jobName}/overlays`);
  }

  getOverlayPayload(runName: string, jobName: string, overlayName: string): Observable<ClusterOverlayPayload> {
    return this.http.get<ClusterOverlayPayload>(
      `${this.baseUrl}/cluster-jobs/${runName}/${jobName}/overlays/${overlayName}`
    );
  }

  // Cluster generation job methods
  generateClusters(pointcloudId: number, request: CreateClusterJobRequest): Observable<ClusterGenerationJob> {
    return this.http.post<ClusterGenerationJob>(
      `${this.baseUrl}/pointclouds/${pointcloudId}/generate-clusters`,
      request
    );
  }

  listClusterGenerationJobs(pointcloudId: number): Observable<ClusterGenerationJob[]> {
    return this.http.get<ClusterGenerationJob[]>(`${this.baseUrl}/pointclouds/${pointcloudId}/cluster-jobs`);
  }

  getClusterGenerationJob(jobId: string): Observable<ClusterGenerationJob> {
    return this.http.get<ClusterGenerationJob>(`${this.baseUrl}/cluster-generation-jobs/${jobId}`);
  }

  listTrainedModels(): Observable<TrainedModel[]> {
    return this.http.get<TrainedModel[]>(`${this.baseUrl}/trained-models`);
  }

  cancelClusterGenerationJob(jobId: string): Observable<ClusterGenerationJob> {
    return this.http.post<ClusterGenerationJob>(`${this.baseUrl}/cluster-generation-jobs/${jobId}/cancel`, {});
  }

  deleteClusterGenerationJob(jobId: string): Observable<ClusterGenerationJob> {
    return this.http.delete<ClusterGenerationJob>(`${this.baseUrl}/cluster-generation-jobs/${jobId}`);
  }
}
