import { CommonModule } from '@angular/common';
import {
  AfterViewInit,
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  OnDestroy,
  OnInit,
  ViewChild,
} from '@angular/core';
import { FormBuilder, FormGroup, ReactiveFormsModule, Validators } from '@angular/forms';
import { FormsModule } from '@angular/forms';
import { Router, RouterModule } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatTooltipModule } from '@angular/material/tooltip';
import { BehaviorSubject, Subject } from 'rxjs';
import { takeUntil } from 'rxjs/operators';

import {
  ProjectDetail,
  ProjectFile,
  ProjectRequest,
  ProjectSummary,
  ProjectUpdateRequest,
  ProjectUploadResponse,
} from '../../core/models/project.model';
import { PointCloud, PointCloudBoundsCorner } from '../../core/models/point-cloud.model';
import { ProjectService } from '../../core/services/project.service';

@Component({
  selector: 'app-projects-dashboard',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    CommonModule,
    ReactiveFormsModule,
    FormsModule,
    RouterModule,
    MatButtonModule,
    MatIconModule,
    MatProgressSpinnerModule,
    MatTooltipModule,
  ],
  templateUrl: './projects-dashboard.component.html',
  styleUrl: './projects-dashboard.component.scss',
})
export class ProjectsDashboardComponent implements OnInit, AfterViewInit, OnDestroy {
  @ViewChild('mapContainer') mapContainer?: ElementRef<HTMLDivElement>;

  projects$ = this.projectService.projects$;
  selectedProject$ = this.projectService.selectedProject$;
  isLoading$ = this.projectService.isLoading$;
  isSaving$ = this.projectService.isSaving$;
  error$ = this.projectService.error$;

  projectForm: FormGroup;
  isCreateMode$ = new BehaviorSubject<boolean>(false);
  private destroy$ = new Subject<void>();
  private currentProject: ProjectDetail | null = null;

  // Map state
  private L: any;
  private map: any;
  private mapInitialized = false;
  private geometryLayer: any;
  private pointCloudLayerGroup: any;
  private centroidMarker: any;
  private poleLayerGroup: any;
  private feedbackTimeout?: number;
  mapLayerVisibility: Record<'geometry' | 'poles', boolean> = {
    geometry: true,
    poles: true,
  };

  // Upload state
  selectedFile: File | null = null;
  fileDescription = '';
  uploadFeedback: string | null = null;
  uploadFeedbackType: 'success' | 'warning' | 'error' = 'success';

  private pendingUploadTarget: 'poles' | 'files' | null = null;

  constructor(
    private projectService: ProjectService,
    private fb: FormBuilder,
    private router: Router
  ) {
    this.projectForm = this.fb.group({
      name: ['', [Validators.required, Validators.maxLength(255)]],
      description: [''],
      centroidLat: [''],
      centroidLng: [''],
      geometry: [''],
      metadata: [''],
    });
  }

  toggleMapLayer(layer: 'geometry' | 'poles'): void {
    this.mapLayerVisibility[layer] = !this.mapLayerVisibility[layer];
    this.syncLayerVisibility();
  }

  ngOnInit(): void {
    this.projectService.loadProjects();

    this.selectedProject$
      .pipe(takeUntil(this.destroy$))
      .subscribe((project) => {
        if (project) {
          this.currentProject = project;
          this.isCreateMode$.next(false);
          this.patchForm(project);
          this.renderProjectOnMap(project);
        } else {
          this.currentProject = null;
          this.projectForm.reset();
          if (this.mapInitialized) {
            this.resetMapView();
          }
        }
      });
  }

  async ngAfterViewInit(): Promise<void> {
    if (!this.mapContainer) {
      return;
    }

    try {
      const leafletModule = await import('leaflet');
      this.L = leafletModule.default || leafletModule;

      this.map = this.L.map(this.mapContainer.nativeElement, {
        center: [39.5, -105.5],
        zoom: 6,
        attributionControl: false,
        zoomControl: true,
      });

      this.L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
        maxZoom: 19,
        subdomains: 'abcd',
      }).addTo(this.map);

      this.mapInitialized = true;

      if (this.currentProject) {
        this.renderProjectOnMap(this.currentProject);
      }
    } catch (error) {
      console.error('Failed to initialize project map:', error);
    }
  }

  ngOnDestroy(): void {
    if (this.feedbackTimeout) {
      clearTimeout(this.feedbackTimeout);
      this.feedbackTimeout = undefined;
    }
    this.destroy$.next();
    this.destroy$.complete();
  }

  startCreate(): void {
    this.isCreateMode$.next(true);
    this.currentProject = null;
    this.selectedFile = null;
    this.fileDescription = '';
    this.pendingUploadTarget = null;
    this.uploadFeedback = null;
    this.projectForm.reset();
    this.projectForm.patchValue({
      name: '',
      description: '',
      centroidLat: '',
      centroidLng: '',
      geometry: '',
      metadata: '',
    });
    this.resetMapView();
  }

  selectProject(project: ProjectSummary): void {
    this.pendingUploadTarget = null;
    this.selectedFile = null;
    this.fileDescription = '';
    this.uploadFeedback = null;
    this.projectService.selectProject(project.id);
  }

  triggerPoleUpload(input: HTMLInputElement): void {
    if (!this.currentProject) {
      return;
    }
    this.pendingUploadTarget = 'poles';
    input.value = '';
    input.click();
  }

  prepareFileAttachment(): void {
    this.pendingUploadTarget = 'files';
  }

  triggerDatasetUpload(): void {
    if (!this.currentProject) {
      return;
    }
    void this.router.navigate(['/point-clouds'], {
      queryParams: {
        upload: '1',
        projectId: this.currentProject.id,
      },
      queryParamsHandling: 'merge',
    });
  }

  saveProject(): void {
    if (this.projectForm.invalid) {
      this.projectForm.markAllAsTouched();
      return;
    }

    const geometry = this.parseJsonField(this.projectForm.value.geometry);
    if (geometry === false) {
      window.alert('Geometry must be valid JSON or empty.');
      return;
    }

    const metadata = this.parseJsonField(this.projectForm.value.metadata);
    if (metadata === false) {
      window.alert('Metadata must be valid JSON or empty.');
      return;
    }

    const centroid = this.buildCentroid();
    const payload: ProjectUpdateRequest = {
      name: this.projectForm.value.name?.trim(),
      description: this.projectForm.value.description?.trim() || null,
      geometry: geometry ?? null,
      metadata: metadata ?? null,
      centroid,
    };

    if (this.isCreateMode$.value) {
      const request: ProjectRequest = payload as ProjectRequest;
      this.projectService
        .createProject(request)
        .pipe(takeUntil(this.destroy$))
        .subscribe({
          next: (project) => {
            this.isCreateMode$.next(false);
            this.projectService.selectProject(project.id);
          },
        });
      return;
    }

    if (!this.currentProject) {
      return;
    }

    this.projectService
      .updateProject(this.currentProject.id, payload)
      .pipe(takeUntil(this.destroy$))
      .subscribe();
  }

  deleteProject(project: ProjectSummary | ProjectDetail | null | undefined): void {
    if (!project) {
      return;
    }

    const confirmed = window.confirm(`Delete project "${project.name}"? This cannot be undone.`);
    if (!confirmed) {
      return;
    }

    this.projectService
      .deleteProject(project.id)
      .pipe(takeUntil(this.destroy$))
      .subscribe();
  }

  onFileChange(event: Event): void {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) {
      if (this.pendingUploadTarget === 'poles') {
        this.pendingUploadTarget = null;
      }
      return;
    }

    this.selectedFile = file;

    const extension = file.name.split('.').pop()?.toLowerCase() ?? '';
    let target: 'poles' | 'files' =
      this.pendingUploadTarget ?? (extension === 'kml' || extension === 'kmz' ? 'poles' : 'files');

    if (!this.currentProject) {
      target = 'files';
    }

    if (target === 'poles' && this.currentProject) {
      this.fileDescription = 'Pole import';
      this.uploadAttachment();
    } else {
      this.fileDescription = '';
    }

    this.pendingUploadTarget = null;
    if (input) {
      input.value = '';
    }
  }

  uploadAttachment(): void {
    if (!this.currentProject || !this.selectedFile) {
      return;
    }

    this.projectService
      .uploadFile(this.currentProject.id, this.selectedFile, this.fileDescription)
      .pipe(takeUntil(this.destroy$))
      .subscribe({
        next: (response: ProjectUploadResponse) => {
          const project = response.project;
          this.selectedFile = null;
          this.fileDescription = '';
          this.projectService.selectProject(project.id);
          if (this.feedbackTimeout) {
            clearTimeout(this.feedbackTimeout);
          }

          if (response.parseError) {
            this.uploadFeedbackType = 'warning';
            this.uploadFeedback = `Processed file but encountered an issue: ${response.parseError}`;
          } else if (response.parseSummary) {
            this.uploadFeedbackType = 'success';
            this.uploadFeedback = `KML processed: ${response.parseSummary.poleCount} pole${response.parseSummary.poleCount === 1 ? '' : 's'} detected.`;
          } else {
            this.uploadFeedbackType = 'success';
            this.uploadFeedback = 'File uploaded successfully.';
          }
          this.feedbackTimeout = window.setTimeout(() => {
            this.uploadFeedback = null;
            this.feedbackTimeout = undefined;
          }, 5000);
        },
      });
  }

  removeAttachment(file: ProjectFile): void {
    if (!this.currentProject) {
      return;
    }

    const confirmed = window.confirm(`Delete ${file.originalFilename}?`);
    if (!confirmed) {
      return;
    }

    this.projectService
      .deleteFile(this.currentProject.id, file.id)
      .pipe(takeUntil(this.destroy$))
      .subscribe();
  }

  formatFileSize(bytes: number): string {
    if (!bytes) {
      return '0 B';
    }
    if (bytes >= 1_000_000_000) {
      return `${(bytes / 1_000_000_000).toFixed(1)} GB`;
    }
    if (bytes >= 1_000_000) {
      return `${(bytes / 1_000_000).toFixed(1)} MB`;
    }
    if (bytes >= 1_000) {
      return `${(bytes / 1_000).toFixed(1)} KB`;
    }
    return `${bytes} B`;
  }

  getFileExtension(filename: string): string {
    if (!filename) {
      return 'FILE';
    }
    const parts = filename.split('.');
    if (parts.length <= 1) {
      return 'FILE';
    }
    return parts.pop()!.slice(0, 4).toUpperCase();
  }

  poleCount(project: ProjectDetail | ProjectSummary | null | undefined): number {
    if (!project) {
      return 0;
    }
    if ('poles' in project && Array.isArray(project.poles)) {
      return project.poles.length;
    }
    return project.poleCount ?? 0;
  }

  datasetCount(project: ProjectDetail | ProjectSummary | null | undefined): number {
    return project?.pointCloudCount ?? 0;
  }

  private parseJsonField(value: string | null | undefined): Record<string, unknown> | null | false {
    if (!value || !value.trim()) {
      return null;
    }

    try {
      return JSON.parse(value);
    } catch (error) {
      console.error('Invalid JSON value:', error);
      return false;
    }
  }

  private buildCentroid(): { lat: number; lng: number } | null {
    const latRaw = this.projectForm.value.centroidLat;
    const lngRaw = this.projectForm.value.centroidLng;

    if (latRaw === '' && lngRaw === '') {
      return null;
    }

    const lat = parseFloat(latRaw);
    const lng = parseFloat(lngRaw);

    if (Number.isNaN(lat) || Number.isNaN(lng)) {
      window.alert('Centroid must include valid latitude and longitude.');
      return null;
    }

    return { lat, lng };
  }

  private patchForm(project: ProjectDetail): void {
    this.projectForm.patchValue({
      name: project.name,
      description: project.description ?? '',
      centroidLat: project.centroid?.lat ?? '',
      centroidLng: project.centroid?.lng ?? '',
      geometry: project.geometry ? JSON.stringify(project.geometry, null, 2) : '',
      metadata: project.metadata ? JSON.stringify(project.metadata, null, 2) : '',
    });
  }

  private renderProjectOnMap(project: ProjectDetail): void {
    if (!this.mapInitialized || !this.L) {
      return;
    }

    this.clearMapOverlays();

    const aggregateBounds = this.L.latLngBounds([]);

    if (project.geometry) {
      this.geometryLayer = this.L.geoJSON(project.geometry, {
        style: {
          color: '#f97316',
          weight: 2,
          fillColor: '#fb923c',
          fillOpacity: 0.2,
        },
      });

      this.applyLayerVisibility(this.geometryLayer, this.mapLayerVisibility.geometry);

      const layerBounds = this.geometryLayer.getBounds();
      if (layerBounds.isValid()) {
        aggregateBounds.extend(layerBounds);
      }
    }

    const pointCloudLayers: any[] = [];
    project.pointClouds.forEach((pc) => {
      const footprintLayer = this.createFootprintLayer(pc);
      if (footprintLayer) {
        pointCloudLayers.push(footprintLayer);
        aggregateBounds.extend(footprintLayer.getBounds());
        return;
      }

      const latLngBounds = this.getLatLngBoundsForPointCloud(pc);
      if (!latLngBounds) {
        return;
      }

      const rectangle = this.L.rectangle(latLngBounds, {
        color: '#0ea5e9',
        weight: 2,
        fillColor: '#38bdf8',
        fillOpacity: 0.2,
      });
      pointCloudLayers.push(rectangle);
      aggregateBounds.extend(rectangle.getBounds());
    });

    if (pointCloudLayers.length > 0) {
      this.pointCloudLayerGroup = this.L.featureGroup(pointCloudLayers).addTo(this.map);
    }

    if (project.centroid) {
      this.centroidMarker = this.L.circleMarker([project.centroid.lat, project.centroid.lng], {
        radius: 6,
        color: '#34d399',
        fillColor: '#34d399',
        fillOpacity: 0.9,
      }).addTo(this.map);
      aggregateBounds.extend([project.centroid.lat, project.centroid.lng]);
    }

    const poleMarkers: any[] = [];
    if (Array.isArray(project.poles)) {
      project.poles.forEach((pole) => {
        if (typeof pole.lat !== 'number' || typeof pole.lng !== 'number') {
          return;
        }
        const marker = this.L.circleMarker([pole.lat, pole.lng], {
          radius: 4,
          color: '#ef4444',
          fillColor: '#ef4444',
          fillOpacity: 0.95,
          weight: 1,
        });
        if (pole.name) {
          marker.bindTooltip(pole.name, { direction: 'top', offset: [0, -6] });
        }
        poleMarkers.push(marker);
      });

      if (poleMarkers.length > 0) {
        this.poleLayerGroup = this.L.featureGroup(poleMarkers);
        this.applyLayerVisibility(this.poleLayerGroup, this.mapLayerVisibility.poles);
        aggregateBounds.extend(this.poleLayerGroup.getBounds());
      }
    }

    if (aggregateBounds.isValid()) {
      this.map.fitBounds(aggregateBounds, { padding: [30, 30] });
    } else {
      this.map.setView([39.5, -105.5], 6);
    }
  }

  private resetMapView(): void {
    if (!this.mapInitialized) {
      return;
    }
    this.clearMapOverlays();
    this.map.setView([39.5, -105.5], 6);
  }

  private clearMapOverlays(): void {
    if (!this.mapInitialized || !this.map) {
      return;
    }
    if (this.geometryLayer) {
      this.geometryLayer.removeFrom(this.map);
      this.geometryLayer = null;
    }
    if (this.pointCloudLayerGroup) {
      this.pointCloudLayerGroup.clearLayers();
      this.pointCloudLayerGroup.removeFrom(this.map);
      this.pointCloudLayerGroup = null;
    }
    if (this.centroidMarker) {
      this.centroidMarker.removeFrom(this.map);
      this.centroidMarker = null;
    }
    if (this.poleLayerGroup) {
      this.poleLayerGroup.clearLayers();
      this.poleLayerGroup.removeFrom(this.map);
      this.poleLayerGroup = null;
    }
  }

  private syncLayerVisibility(): void {
    if (!this.mapInitialized || !this.map) {
      return;
    }

    this.applyLayerVisibility(this.geometryLayer, this.mapLayerVisibility.geometry);
    this.applyLayerVisibility(this.poleLayerGroup, this.mapLayerVisibility.poles);
  }

  private applyLayerVisibility(layer: any, visible: boolean): void {
    if (!layer || !this.map) {
      return;
    }

    const isOnMap = this.map.hasLayer(layer);
    if (visible && !isOnMap) {
      layer.addTo(this.map);
    } else if (!visible && isOnMap) {
      layer.removeFrom(this.map);
    }
  }

  private getLatLngBoundsForPointCloud(pointCloud: PointCloud): [[number, number], [number, number]] | null {
    const bounds = pointCloud.bounds;
    if (!bounds) {
      return null;
    }

    const geographic = bounds.geographic;
    if (geographic?.southWest && geographic?.northEast) {
      const sw = geographic.southWest;
      const ne = geographic.northEast;
      if (this.isValidLatLng(sw.lat, sw.lng) && this.isValidLatLng(ne.lat, ne.lng)) {
        return [
          [sw.lat, sw.lng],
          [ne.lat, ne.lng],
        ];
      }
    }

    const minCorner = bounds.min;
    const maxCorner = bounds.max;
    if (!minCorner || !maxCorner) {
      return null;
    }

    return this.approximateProjectedBoundsToLatLng(minCorner, maxCorner);
  }

  private createFootprintLayer(pointCloud: PointCloud): any | null {
    if (!this.L || !pointCloud.footprint) {
      return null;
    }

    try {
      const layer = this.L.geoJSON(pointCloud.footprint, {
        style: {
          color: '#0ea5e9',
          weight: 2,
          fillColor: '#38bdf8',
          fillOpacity: 0.2,
        },
      });

      const bounds = layer.getBounds();
      if (!bounds || !bounds.isValid()) {
        return null;
      }

      return layer;
    } catch (error) {
      console.warn('Failed to render point cloud footprint on map:', error);
      return null;
    }
  }

  private approximateProjectedBoundsToLatLng(
    min: PointCloudBoundsCorner,
    max: PointCloudBoundsCorner
  ): [[number, number], [number, number]] | null {
    if (!this.L) {
      return null;
    }

    if (
      typeof min.x !== 'number' ||
      typeof min.y !== 'number' ||
      typeof max.x !== 'number' ||
      typeof max.y !== 'number'
    ) {
      return null;
    }

    // Fallback approximation that assumes UTM-like projection if precise CRS conversion is unavailable.
    const centralMeridian = -105;
    const falseEasting = 500000;
    const k0 = 0.9996;

    const x1 = (min.x - falseEasting) / k0;
    const x2 = (max.x - falseEasting) / k0;
    const y1 = min.y / k0;
    const y2 = max.y / k0;

    const lat1 = (y1 / 111320) - 0.5;
    const lat2 = (y2 / 111320) - 0.5;
    const lng1 = centralMeridian + x1 / (111320 * Math.cos((lat1 * Math.PI) / 180));
    const lng2 = centralMeridian + x2 / (111320 * Math.cos((lat2 * Math.PI) / 180));

    return [
      [lat1, lng1],
      [lat2, lng2],
    ];
  }

  private isValidLatLng(lat: number | null | undefined, lng: number | null | undefined): boolean {
    return typeof lat === 'number' && Number.isFinite(lat) && typeof lng === 'number' && Number.isFinite(lng);
  }
}
