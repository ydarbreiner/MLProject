import { Injectable } from '@angular/core';
import { ApiService } from './api.service';
import { Observable, Subject, from } from 'rxjs';
import { catchError, concatMap, retry, takeUntil, tap } from 'rxjs/operators';

export type UploadState = 'uploading' | 'uploaded';

export interface UploadProgressEvent {
  progress: number;
  state: UploadState;
  response?: any;
}

@Injectable({
  providedIn: 'root',
})
export class UploadService {
  private cancellationSubject: Subject<void> | null = null;
  private isUploading = false;

  constructor(private apiService: ApiService) {}

  uploadFile(file: File, projectId?: number | null): Observable<UploadProgressEvent> {
    const allowedExtensions = ['.las', '.laz'];
    const fileExtension = file.name.split('.').pop()?.toLowerCase();
    if (!fileExtension || !allowedExtensions.includes(`.${fileExtension}`)) {
      const error = new Error('Invalid file type. Only .las and .laz files are allowed.');
      return new Observable(observer => {
        observer.error(error);
      });
    }

    if (this.isUploading) {
      const error = new Error('Another upload is already in progress.');
      return new Observable(observer => {
        observer.error(error);
      });
    }

    this.isUploading = true;
    const chunkSize = 5 * 1024 * 1024; // 5MB chunks
    const totalChunks = Math.ceil(file.size / chunkSize);
    const chunks = Array.from({ length: totalChunks }, (_, i) => i);

    // Reset cancellation subject for new upload
    this.cancellationSubject = new Subject<void>();

    let finalResponse: any = null;
    const cancellation$ = this.cancellationSubject;

    return new Observable<UploadProgressEvent>(observer => {
      from(chunks)
        .pipe(
          concatMap(chunkIndex => {
            const start = chunkIndex * chunkSize;
            const end = Math.min(start + chunkSize, file.size);
            const chunk = file.slice(start, end);
            const formData = new FormData();
            formData.append('file', chunk, file.name);
            formData.append('chunkIndex', chunkIndex.toString());
            formData.append('totalChunks', totalChunks.toString());
            formData.append('filename', file.name);
            if (projectId != null) {
              formData.append('projectId', projectId.toString());
            }

            return this.apiService.uploadPointCloud(formData).pipe(
              retry(3),
              tap((response) => {
                const progress = ((chunkIndex + 1) / totalChunks) * 100;
                observer.next({ progress, state: 'uploading' });

                // Store final response for completion
                if (chunkIndex === totalChunks - 1) {
                  finalResponse = response;
                }
              }),
              catchError(error => {
                console.error(`Upload failed for chunk ${chunkIndex}:`, error);
                throw error;
              })
            );
          }),
          takeUntil(cancellation$!)
        )
        .subscribe({
          complete: () => {
            this.isUploading = false;
            observer.next({
              progress: 100,
              state: 'uploaded',
              response: finalResponse,
            });
            observer.complete();
            console.log('✅ Upload completed:', finalResponse);
          },
          error: (error) => {
            this.isUploading = false;
            observer.error(error);
          }
        });
    });
  }

  cancelUpload() {
    if (this.cancellationSubject) {
      this.cancellationSubject.next();
      this.cancellationSubject.complete();
      this.cancellationSubject = null;
    }
    this.isUploading = false;
  }
}
