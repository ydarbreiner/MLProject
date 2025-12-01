import { Injectable } from '@angular/core';
import { BehaviorSubject, Observable, throwError } from 'rxjs';
import { catchError, map, tap } from 'rxjs/operators';

import { ProjectDetail, ProjectRequest, ProjectSummary, ProjectUpdateRequest, ProjectUploadResponse } from '../models/project.model';
import { PointCloud } from '../models/point-cloud.model';
import { ApiService } from './api.service';

@Injectable({
  providedIn: 'root',
})
export class ProjectService {
  private projectsSubject = new BehaviorSubject<ProjectSummary[]>([]);
  private selectedProjectSubject = new BehaviorSubject<ProjectDetail | null>(null);
  private isLoadingSubject = new BehaviorSubject<boolean>(false);
  private isSavingSubject = new BehaviorSubject<boolean>(false);
  private errorSubject = new BehaviorSubject<string | null>(null);

  readonly projects$ = this.projectsSubject.asObservable();
  readonly selectedProject$ = this.selectedProjectSubject.asObservable();
  readonly isLoading$ = this.isLoadingSubject.asObservable();
  readonly isSaving$ = this.isSavingSubject.asObservable();
  readonly error$ = this.errorSubject.asObservable();

  constructor(private apiService: ApiService) {}

  loadProjects(): void {
    this.isLoadingSubject.next(true);
    this.apiService
      .getProjects()
      .pipe(
        tap((projects) => {
          this.projectsSubject.next(projects);
          this.errorSubject.next(null);
          this.isLoadingSubject.next(false);
        }),
        catchError((err) => {
          console.error('Failed to load projects:', err);
          this.errorSubject.next('Failed to load projects');
          this.isLoadingSubject.next(false);
          return throwError(() => err);
        })
      )
      .subscribe();
  }

  selectProject(projectId: number): void {
    this.isLoadingSubject.next(true);
    this.apiService
      .getProject(projectId)
      .pipe(
        tap((project) => {
          this.selectedProjectSubject.next(project);
          this.errorSubject.next(null);
          this.isLoadingSubject.next(false);
          this.upsertProjectSummary(project);
        }),
        catchError((err) => {
          console.error(`Failed to load project ${projectId}:`, err);
          this.errorSubject.next('Failed to load project');
          this.isLoadingSubject.next(false);
          return throwError(() => err);
        })
      )
      .subscribe();
  }

  clearSelectedProject(): void {
    this.selectedProjectSubject.next(null);
  }

  createProject(request: ProjectRequest): Observable<ProjectDetail> {
    this.isSavingSubject.next(true);
    return this.apiService.createProject(request).pipe(
      tap((project) => {
        this.isSavingSubject.next(false);
        this.errorSubject.next(null);
        this.selectedProjectSubject.next(project);
        this.upsertProjectSummary(project);
      }),
      catchError((err) => {
        console.error('Failed to create project:', err);
        this.isSavingSubject.next(false);
        this.errorSubject.next('Failed to create project');
        return throwError(() => err);
      })
    );
  }

  updateProject(projectId: number, request: ProjectUpdateRequest): Observable<ProjectDetail> {
    this.isSavingSubject.next(true);
    return this.apiService.updateProject(projectId, request).pipe(
      tap((project) => {
        this.isSavingSubject.next(false);
        this.errorSubject.next(null);
        this.selectedProjectSubject.next(project);
        this.upsertProjectSummary(project);
      }),
      catchError((err) => {
        console.error(`Failed to update project ${projectId}:`, err);
        this.isSavingSubject.next(false);
        this.errorSubject.next('Failed to update project');
        return throwError(() => err);
      })
    );
  }

  deleteProject(projectId: number): Observable<void> {
    this.isSavingSubject.next(true);
    return this.apiService.deleteProject(projectId).pipe(
      tap(() => {
        this.isSavingSubject.next(false);
        const remaining = this.projectsSubject.value.filter((p) => p.id !== projectId);
        this.projectsSubject.next(remaining);

        if (this.selectedProjectSubject.value?.id === projectId) {
          this.selectedProjectSubject.next(null);
        }
      }),
      catchError((err) => {
        console.error(`Failed to delete project ${projectId}:`, err);
        this.isSavingSubject.next(false);
        this.errorSubject.next('Failed to delete project');
        return throwError(() => err);
      })
    );
  }

  assignPointCloudToProject(pointCloudId: number, projectId: number | null): Observable<PointCloud> {
    this.isSavingSubject.next(true);
    return this.apiService.updatePointCloud(pointCloudId, { projectId }).pipe(
      tap(() => {
        this.isSavingSubject.next(false);
        this.loadProjects();
        const selected = this.selectedProjectSubject.value;
        if (selected) {
          this.selectProject(selected.id);
        }
      }),
      catchError((err) => {
        console.error(`Failed to assign point cloud ${pointCloudId} to project ${projectId}:`, err);
        this.isSavingSubject.next(false);
        this.errorSubject.next('Failed to update point cloud project');
        return throwError(() => err);
      })
    );
  }

  uploadFile(projectId: number, file: File, description?: string | null): Observable<ProjectUploadResponse> {
    const formData = new FormData();
    formData.append('file', file);
    if (description && description.trim()) {
      formData.append('description', description.trim());
    }

    this.isSavingSubject.next(true);
    return this.apiService.uploadProjectFile(projectId, formData).pipe(
      tap((response) => {
        this.isSavingSubject.next(false);
        this.selectedProjectSubject.next(response.project);
        this.upsertProjectSummary(response.project);
        this.errorSubject.next(response.parseError ?? null);
      }),
      catchError((err) => {
        console.error(`Failed to upload project file for project ${projectId}:`, err);
        this.isSavingSubject.next(false);
        this.errorSubject.next('Failed to upload file');
        return throwError(() => err);
      })
    );
  }

  deleteFile(projectId: number, fileId: number): Observable<void> {
    this.isSavingSubject.next(true);
    return this.apiService.deleteProjectFile(projectId, fileId).pipe(
      tap(() => {
        this.isSavingSubject.next(false);
        const selected = this.selectedProjectSubject.value;
        if (selected) {
          this.selectProject(selected.id);
        }
      }),
      catchError((err) => {
        console.error(`Failed to delete project file ${fileId}:`, err);
        this.isSavingSubject.next(false);
        this.errorSubject.next('Failed to delete file');
        return throwError(() => err);
      })
    );
  }

  fetchProjectDetail(projectId: number): Observable<ProjectDetail> {
    return this.apiService.getProject(projectId).pipe(
      tap((project) => this.upsertProjectSummary(project)),
      catchError((err) => {
        console.error(`Failed to fetch project detail ${projectId}:`, err);
        return throwError(() => err);
      })
    );
  }

  private upsertProjectSummary(project: ProjectDetail | ProjectSummary): void {
    const current = [...this.projectsSubject.value];
    const poleCount = 'poles' in project && Array.isArray(project.poles)
      ? project.poles.length
      : project.poleCount ?? 0;

    const summary: ProjectSummary = {
      id: project.id,
      name: project.name,
      description: project.description,
      geometry: project.geometry,
      centroid: project.centroid,
      metadata: project.metadata,
      pointCloudCount: project.pointCloudCount,
      fileCount: project.fileCount,
      totalFileSize: project.totalFileSize,
      poleCount,
      createdAt: project.createdAt,
      updatedAt: project.updatedAt,
    };

    const index = current.findIndex((p) => p.id === project.id);
    if (index >= 0) {
      current[index] = summary;
    } else {
      current.unshift(summary);
    }
    this.projectsSubject.next(current);
  }
}
