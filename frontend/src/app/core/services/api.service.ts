import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';

import {
  ClassificationEditRequest,
  ClassificationEditResponse,
  ClassificationEditStatusResponse,
} from '../models/classification-edit.models';
import { ProjectDetail, ProjectRequest, ProjectSummary, ProjectUpdateRequest, ProjectUploadResponse } from '../models/project.model';
import { PointCloud, PointCloudPole, PointCloudPoleUpdateRequest, PointCloudPolesResponse } from '../models/point-cloud.model';

@Injectable({
  providedIn: 'root',
})
export class ApiService {
  private apiUrl = 'http://localhost:8000/api';

  constructor(private http: HttpClient) {}

  getApiUrl(): string {
    return this.apiUrl;
  }

  uploadPointCloud(formData: FormData): Observable<any> {
    return this.http.post(`${this.apiUrl}/upload`, formData);
  }

  getPointClouds(): Observable<PointCloud[]> {
    return this.http.get<PointCloud[]>(`${this.apiUrl}/pointclouds`);
  }

  getPointCloud(id: number): Observable<PointCloud> {
    return this.http.get<PointCloud>(`${this.apiUrl}/pointclouds/${id}`);
  }

  getPointCloudPoles(pointCloudId: number): Observable<PointCloudPolesResponse> {
    return this.http.get<PointCloudPolesResponse>(`${this.apiUrl}/pointclouds/${pointCloudId}/poles`);
  }

  deletePointCloud(id: number): Observable<any> {
    return this.http.delete(`${this.apiUrl}/pointclouds/${id}`);
  }

  getLatestPointCloud(): Observable<any> {
    return this.http.get(`${this.apiUrl}/pointclouds/latest`);
  }

  getSystemStatus(): Observable<any> {
    return this.http.get(`${this.apiUrl}/system/status`);
  }

  applyClassificationEdits(pointCloudId: number, payload: ClassificationEditRequest): Observable<ClassificationEditResponse> {
    return this.http.post<ClassificationEditResponse>(
      `${this.apiUrl}/pointclouds/${pointCloudId}/classifications/apply`,
      payload
    );
  }

  getClassificationOverrides(pointCloudId: number): Observable<Record<string, Record<string, number>>> {
    return this.http.get<Record<string, Record<string, number>>>(
      `${this.apiUrl}/pointclouds/${pointCloudId}/classifications/overrides`
    );
  }

  getClassificationStatus(pointCloudId: number): Observable<ClassificationEditStatusResponse[]> {
    return this.http.get<ClassificationEditStatusResponse[]>(
      `${this.apiUrl}/pointclouds/${pointCloudId}/classifications/status`
    );
  }

  getProjects(): Observable<ProjectSummary[]> {
    return this.http.get<ProjectSummary[]>(`${this.apiUrl}/projects`);
  }

  getProject(projectId: number): Observable<ProjectDetail> {
    return this.http.get<ProjectDetail>(`${this.apiUrl}/projects/${projectId}`);
  }

  createProject(payload: ProjectRequest): Observable<ProjectDetail> {
    return this.http.post<ProjectDetail>(`${this.apiUrl}/projects`, payload);
  }

  updateProject(projectId: number, payload: ProjectUpdateRequest): Observable<ProjectDetail> {
    return this.http.patch<ProjectDetail>(`${this.apiUrl}/projects/${projectId}`, payload);
  }

  deleteProject(projectId: number): Observable<void> {
    return this.http.delete<void>(`${this.apiUrl}/projects/${projectId}`);
  }

  uploadProjectFile(projectId: number, formData: FormData): Observable<ProjectUploadResponse> {
    return this.http.post<ProjectUploadResponse>(`${this.apiUrl}/projects/${projectId}/files`, formData);
  }

  deleteProjectFile(projectId: number, fileId: number): Observable<void> {
    return this.http.delete<void>(`${this.apiUrl}/projects/${projectId}/files/${fileId}`);
  }

  updatePointCloud(pointCloudId: number, payload: Partial<{ name: string; projectId: number | null }>): Observable<PointCloud> {
    return this.http.patch<PointCloud>(`${this.apiUrl}/pointclouds/${pointCloudId}`, payload);
  }

  updatePointCloudPole(pointCloudId: number, poleIdentifier: string | number, payload: PointCloudPoleUpdateRequest): Observable<PointCloudPole> {
    return this.http.patch<PointCloudPole>(`${this.apiUrl}/pointclouds/${pointCloudId}/poles/${poleIdentifier}`, payload);
  }

  recolorPointCloud(pointCloudId: number, palette: Record<number, string>): Observable<any> {
    return this.http.post(`${this.apiUrl}/pointclouds/${pointCloudId}/recolor`, { palette });
  }
}
