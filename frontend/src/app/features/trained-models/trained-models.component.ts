import { Component, OnInit } from '@angular/core';
import { CommonModule, Location } from '@angular/common';
import { MatCardModule } from '@angular/material/card';
import { MatTableModule } from '@angular/material/table';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { MatChipsModule } from '@angular/material/chips';
import { ClusterAnalysisService } from '../../core/services/cluster-analysis.service';
import { TrainedModel } from '../../core/models/cluster-analysis.models';

@Component({
  selector: 'app-trained-models',
  standalone: true,
  imports: [
    CommonModule,
    MatCardModule,
    MatTableModule,
    MatProgressSpinnerModule,
    MatIconModule,
    MatButtonModule,
    MatChipsModule,
  ],
  templateUrl: './trained-models.component.html',
  styleUrl: './trained-models.component.scss'
})
export class TrainedModelsComponent implements OnInit {
  models: TrainedModel[] = [];
  loading = false;
  selectedModel: TrainedModel | null = null;

  constructor(
    private clusterAnalysisService: ClusterAnalysisService,
    private location: Location
  ) {}

  ngOnInit(): void {
    this.loadModels();
  }

  loadModels(): void {
    this.loading = true;
    this.clusterAnalysisService.listTrainedModels().subscribe({
      next: (models: TrainedModel[]) => {
        this.models = models;
        this.loading = false;
      },
      error: (error: any) => {
        console.error('Failed to load trained models:', error);
        this.loading = false;
      }
    });
  }

  selectModel(model: TrainedModel): void {
    this.selectedModel = this.selectedModel === model ? null : model;
  }

  formatDate(dateString: string): string {
    return new Date(dateString).toLocaleString();
  }

  getKeyStats(model: TrainedModel): Array<{label: string, value: any}> {
    if (!model.config) return [];

    return [
      { label: 'Training Steps', value: model.config.max_steps || 'N/A' },
      { label: 'Batch Size', value: model.config.batch_size || 'N/A' },
      { label: 'Patches per File', value: model.config.patches_per_file || 'N/A' },
      { label: 'Embedding Dim', value: model.config.embedding_dim || 'N/A' },
      { label: 'Learning Rate', value: model.config.learning_rate || 'N/A' },
      { label: 'Patch Size', value: model.config.patch_size || 'N/A' },
    ];
  }

  goBack(): void {
    this.location.back();
  }

  hasGraphs(model: TrainedModel): boolean {
    if (!model.trainingGraphs) return false;
    return !!(model.trainingGraphs.loss || model.trainingGraphs.lr ||
              model.trainingGraphs.delta || model.trainingGraphs.best);
  }

  getGraphUrl(path: string): string {
    // Backend serves uploads at /uploads
    return `http://localhost:8000${path}`;
  }
}
