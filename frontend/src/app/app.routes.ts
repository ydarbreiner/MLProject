import { Routes } from '@angular/router';
import { PointCloudListComponent } from './features/point-cloud-list/point-cloud-list.component';
import { PointCloudViewerComponent } from './features/viewer/point-cloud-viewer.component';
import { ProjectsDashboardComponent } from './features/projects/projects-dashboard.component';
import { TrainedModelsComponent } from './features/trained-models/trained-models.component';

export const routes: Routes = [
  { path: '', redirectTo: '/point-clouds', pathMatch: 'full' },
  { path: 'point-clouds', component: PointCloudListComponent },
  { path: 'projects', component: ProjectsDashboardComponent },
  { path: 'trained-models', component: TrainedModelsComponent },
  { path: 'viewer/:id', component: PointCloudViewerComponent },
  { path: '**', redirectTo: '/point-clouds' },
];
