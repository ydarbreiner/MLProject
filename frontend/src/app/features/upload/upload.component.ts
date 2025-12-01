import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatCardModule } from '@angular/material/card';
import { UploadService } from '../../core/services/upload.service';
import { PointCloudService } from '../../core/services/point-cloud.service';
import { ProjectService } from '../../core/services/project.service';
import { ProjectSummary } from '../../core/models/project.model';

@Component({
  selector: 'app-upload',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    MatButtonModule,
    MatIconModule,
    MatProgressBarModule,
    MatCardModule
  ],
  templateUrl: './upload.html',
  styleUrls: ['./upload.component.scss']
})
export class UploadComponent implements OnInit {
  isDragOver = false;
  isUploading = false;
  uploadProgress = 0;
  uploadComplete = false;
  selectedFile: File | null = null;
  selectedProjectId: number | null = null;
  projects: ProjectSummary[] = [];
  errorMessage: string | null = null;

  constructor(
    private uploadService: UploadService,
    private pointCloudService: PointCloudService,
    private projectService: ProjectService
  ) {}

  ngOnInit(): void {
    this.projectService.projects$.subscribe((projects) => {
      this.projects = projects;
    });
    this.projectService.loadProjects();
  }

  onDragOver(event: DragEvent): void {
    event.preventDefault();
    this.isDragOver = true;
  }

  onDragLeave(event: DragEvent): void {
    event.preventDefault();
    this.isDragOver = false;
  }

  onDrop(event: DragEvent): void {
    event.preventDefault();
    this.isDragOver = false;

    const files = event.dataTransfer?.files;
    if (files && files.length > 0) {
      this.handleFile(files[0]);
    }
  }

  onFileSelected(event: Event): void {
    const input = event.target as HTMLInputElement;
    if (input.files && input.files.length > 0) {
      this.handleFile(input.files[0]);
    }
  }

  private handleFile(file: File): void {
    if (!file.name.toLowerCase().endsWith('.las') && !file.name.toLowerCase().endsWith('.laz')) {
      this.errorMessage = 'Only LAS and LAZ files are supported.';
      return;
    }

    this.errorMessage = null;
    this.selectedFile = file;
    this.isUploading = true;
    this.uploadProgress = 0;
    this.uploadComplete = false;

    this.pointCloudService.addPointCloud(file, this.selectedProjectId).subscribe({
      next: (event) => {
        const progress = Math.round(event.progress ?? 0);
        this.uploadProgress = progress;
        if (event.state === 'uploaded') {
          this.uploadComplete = true;
          this.isUploading = false;
          setTimeout(() => {
            this.resetUpload();
          }, 3000);
        }
      },
      error: (error) => {
        console.error('Upload failed:', error);
        this.isUploading = false;
        this.errorMessage = error.message ?? 'Upload failed. Please try again.';
      }
    });
  }

  resetUpload(): void {
    this.selectedFile = null;
    this.uploadProgress = 0;
    this.uploadComplete = false;
    this.isUploading = false;
    this.errorMessage = null;
  }

}
