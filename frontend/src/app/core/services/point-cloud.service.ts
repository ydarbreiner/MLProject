// src/app/core/services/point-cloud.service.ts

import { Injectable } from '@angular/core';
import { BehaviorSubject, Observable, interval, throwError } from 'rxjs';
import { catchError, switchMap, takeWhile, tap, startWith } from 'rxjs/operators';
import { PointCloud } from '../models/point-cloud.model';
import { ApiService } from './api.service';
import { UploadProgressEvent, UploadService } from './upload.service';
@Injectable({
  providedIn: 'root',
})
export class PointCloudService {
  private pointCloudsSubject = new BehaviorSubject<PointCloud[]>([]);
  public pointClouds$ = this.pointCloudsSubject.asObservable();

  private selectedPointCloudSubject = new BehaviorSubject<PointCloud | null>(
    null
  );
  public selectedPointCloud$ = this.selectedPointCloudSubject.asObservable();

  private isLoadingSubject = new BehaviorSubject<boolean>(false);
  public isLoading$ = this.isLoadingSubject.asObservable();

  private errorSubject = new BehaviorSubject<string | null>(null);
  public error$ = this.errorSubject.asObservable();

  constructor(
    private apiService: ApiService,
    private uploadService: UploadService
  ) {}

  getPointClouds(): Observable<PointCloud[]> {
    return this.pointClouds$;
  }

  loadPointClouds() {
    this.isLoadingSubject.next(true);
    this.apiService.getPointClouds().pipe(
      catchError(err => {
        console.error('Failed to load point clouds:', err);
        this.errorSubject.next('Failed to load point clouds');
        this.isLoadingSubject.next(false);
        return throwError(() => err);
      })
    ).subscribe({
      next: (pointClouds) => {
        console.log('Loaded point clouds:', pointClouds.length);
        this.pointCloudsSubject.next(pointClouds);
        this.isLoadingSubject.next(false);
      },
      error: (err) => {
        console.error('Error in subscription:', err);
        this.isLoadingSubject.next(false);
      }
    });
  }

  loadPointCloud(id: number) {
    this.isLoadingSubject.next(true);
    this.errorSubject.next(null);
    this.apiService.getPointCloud(id).pipe(
      catchError(err => {
        this.errorSubject.next('Failed to load point cloud.');
        this.isLoadingSubject.next(false);
        return throwError(() => err);
      })
    ).subscribe((pointCloud: PointCloud) => {
      if (pointCloud.status === 'completed' && pointCloud.url) {
        // Use relative URL that will go through the Angular proxy
        const fullUrl = pointCloud.url.startsWith('http')
          ? pointCloud.url
          : pointCloud.url;

        this.selectedPointCloudSubject.next({
          ...pointCloud,
          url: fullUrl
        });
      } else if (pointCloud.status === 'failed') {
        console.log(`⚠️ Point cloud ${id} failed, attempting to load latest completed point cloud...`);
        // Try to load the latest completed point cloud as a fallback
        this.loadLatestPointCloud();
        return;
      } else {
        this.errorSubject.next('Point cloud is still processing. Please try again later.');
      }
      this.isLoadingSubject.next(false);
    });
  }

  selectPointCloud(pointCloud: PointCloud) {
    this.selectedPointCloudSubject.next(pointCloud);
  }

  loadLatestPointCloud() {
    this.isLoadingSubject.next(true);
    this.errorSubject.next(null);
    this.apiService.getLatestPointCloud().pipe(
      catchError(err => {
        this.errorSubject.next('No completed point clouds available.');
        this.isLoadingSubject.next(false);
        return throwError(() => err);
      })
    ).subscribe((pointCloud: PointCloud) => {
      if (pointCloud && pointCloud.status === 'completed' && pointCloud.url) {
        // Use relative URL that will go through the Angular proxy
        const fullUrl = pointCloud.url.startsWith('http')
          ? pointCloud.url
          : pointCloud.url;

        console.log(`✅ Loading latest completed point cloud: ${pointCloud.name} (ID: ${pointCloud.id})`);
        this.selectedPointCloudSubject.next({
          ...pointCloud,
          url: fullUrl
        });
      } else {
        this.errorSubject.next('No completed point clouds available.');
      }
      this.isLoadingSubject.next(false);
    });
  }

  clearPointCloud() {
    this.selectedPointCloudSubject.next(null);
  }

  updatePointCloud(pointCloud: Partial<PointCloud>) {
    const currentPointCloud = this.selectedPointCloudSubject.value;
    if (currentPointCloud) {
      this.selectedPointCloudSubject.next({
        ...currentPointCloud,
        ...pointCloud,
      });
    }
  }

  addPointCloud(file: File, projectId?: number | null) {
    this.isLoadingSubject.next(true);
    this.errorSubject.next(null);

    return this.uploadService.uploadFile(file, projectId).pipe(
      tap((event: UploadProgressEvent) => {
        if (event.state === 'uploaded') {
          console.log('🎉 Upload completed, reloading point clouds...');
          this.loadPointClouds();
          this.isLoadingSubject.next(false);
        }
      }),
      catchError(error => {
        console.error('❌ Upload failed in point cloud service:', error);
        this.errorSubject.next('Upload failed: ' + error.message);
        this.isLoadingSubject.next(false);
        return throwError(() => error);
      })
    );
  }

  watchPointCloudStatus(pointCloudId: number, pollIntervalMs = 5000): Observable<PointCloud> {
    return interval(pollIntervalMs).pipe(
      startWith(0),
      switchMap(() => this.apiService.getPointCloud(pointCloudId)),
      tap(pointCloud => {
        if (pointCloud.status === 'completed') {
          console.log(`✅ Point cloud ${pointCloudId} processing completed.`);
          this.loadPointClouds();
        } else if (pointCloud.status === 'failed') {
          console.warn(`⚠️ Point cloud ${pointCloudId} processing failed: ${pointCloud.errorMessage ?? 'Unknown error'}`);
        }
      }),
      takeWhile(pointCloud => pointCloud.status === 'processing', true),
      catchError(error => {
        console.error(`❌ Failed to poll point cloud ${pointCloudId}:`, error);
        return throwError(() => error);
      })
    );
  }

  deletePointCloud(id: number): Observable<any> {
    this.isLoadingSubject.next(true);
    return this.apiService.deletePointCloud(id).pipe(
      tap(() => {
        console.log(`🗑️ Point cloud ${id} deleted successfully`);
        this.loadPointClouds(); // Refresh the list
      }),
      catchError(error => {
        console.error(`❌ Failed to delete point cloud ${id}:`, error);
        this.errorSubject.next('Delete failed: ' + error.message);
        this.isLoadingSubject.next(false);
        return throwError(() => error);
      })
    );
  }
}
