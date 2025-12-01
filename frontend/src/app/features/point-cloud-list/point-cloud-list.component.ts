import { Component, OnInit, ViewChild, ElementRef, AfterViewInit, HostListener, OnDestroy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatSelectModule } from '@angular/material/select';
import { ActivatedRoute, Router } from '@angular/router';
import { PointCloudService } from '../../core/services/point-cloud.service';
import { PointCloud, PointCloudBoundsCorner, PointCloudFootprint } from '../../core/models/point-cloud.model';
import { ProjectService } from '../../core/services/project.service';
import { ProjectDetail, ProjectPole, ProjectSummary } from '../../core/models/project.model';
import { Subject, Subscription } from 'rxjs';
import { takeUntil } from 'rxjs/operators';

interface UploadQueueItem {
  file: File;
  progress: number;
  status: 'pending' | 'uploading' | 'processing' | 'completed' | 'failed';
  error?: string;
  pointCloudId?: number;
  targetProjectId: number | null;
}

interface PoleMatchCandidate {
  cloud: PointCloud;
  matchType: 'footprint' | 'geographic' | 'approximate' | 'nearest';
  score: number;
  distanceKm?: number;
}

interface PoleMatch {
  pole: ProjectPole;
  index: number;
  pointCloud: PointCloud | null;
  status: 'ready' | 'processing' | 'missing';
  matchType: 'footprint' | 'geographic' | 'approximate' | 'nearest' | 'unknown';
  distanceKm?: number;
  description?: string | null;
}

@Component({
  selector: 'app-point-cloud-list',
  standalone: true,
  imports: [CommonModule, FormsModule, MatFormFieldModule, MatSelectModule],
  templateUrl: './point-cloud-list.html',
  styleUrls: ['./point-cloud-list.scss']
})
export class PointCloudListComponent implements OnInit, AfterViewInit, OnDestroy {
  @ViewChild('mapElement') mapElement!: ElementRef;
  @ViewChild('previewCanvas') previewCanvas?: ElementRef<HTMLCanvasElement>;

  // Data
  allFiles: PointCloud[] = [];
  filteredFiles: PointCloud[] = [];
  projectSummaries: ProjectSummary[] = [];
  filteredProjects: ProjectSummary[] = [];

  // State
  selectedFile: PointCloud | null = null;
  selectedProject: 'all' | 'unassigned' | number = 'all';
  selectedProjectForNav: ProjectSummary | null = null; // For keyboard navigation
  viewMode: 'map' | 'list' | 'split' = 'split';
  sortField: 'name' | 'project' | 'area' | 'points' = 'name';
  sortDirection: 'asc' | 'desc' = 'desc';
  searchQuery: string = '';
  unassignedCount = 0;
  areaDisplayUnit: 'metric' | 'imperial' = 'metric';

  // Upload
  showUploadModal = false;
  uploadQueue: UploadQueueItem[] = [];
  uploadProjectId: number | null = null;
  isUploadQueueProcessing = false;

  // Stats
  totalFiles = 0;
  totalStorage = '0 B';

  // Map with Leaflet
  private map: any = null;
  private L: any = null;
  private filePolygons: Map<number, any> = new Map();
  private hoveredFileId: number | null = null;
  private mapInitialized = false;
  private deletingPointCloudIds = new Set<number>();
  private destroy$ = new Subject<void>();
  private pollSubscriptions = new Map<number, Subscription>();
  private projectDetailSubscription?: Subscription;
  private projectGeometryLayer: any = null;
  private projectPoleLayer: any = null;
  private projectCentroidMarker: any = null;
  private projectOverlayBounds: any = null;
  private currentRectBounds: any = null;
  private lastAssignmentSelection: number | null = null;
  poleMatches: PoleMatch[] = [];
  poleSearchQuery = '';
  private poleMarkerMap = new Map<number, any>();
  private activePoleIndex: number | null = null;
  private hoverPoleIndex: number | null = null;
  mapLayerVisibility: Record<'geometry' | 'poles', boolean> = {
    geometry: true,
    poles: true,
  };

  // Project markers for All Projects view
  private projectMarkers = new Map<number, any>();
  private projectBoundaryLayers = new Map<number, any>();
  private projectMarkersLoaded = false;

  activeProjectDetail: ProjectDetail | null = null;
  assignmentDraftProjectId: number | null = null;
  isAssigningProject = false;
  assignmentError: string | null = null;

  constructor(
    private pointCloudService: PointCloudService,
    private router: Router,
    private projectService: ProjectService,
    private route: ActivatedRoute
  ) {}

  ngOnInit(): void {
    // Set map view by default for "All Projects"
    if (this.selectedProject === 'all') {
      this.viewMode = 'map';
    }

    this.loadFiles();
    this.projectService.loadProjects();
    this.projectService.projects$
      .pipe(takeUntil(this.destroy$))
      .subscribe({
        next: (projects) => {
          this.projectSummaries = projects;
          // Update project markers when projects are loaded
          if (this.selectedProject === 'all' && this.mapInitialized) {
            this.updateAllProjectsMapView();
          }
        }
      });

    this.pointCloudService.pointClouds$
      .pipe(takeUntil(this.destroy$))
      .subscribe({
        next: (files) => {
          console.log('Received files:', files.length);
          // Filter out failed files (they shouldn't be displayed)
          this.allFiles = files.filter(f => f.status !== 'failed');
          this.unassignedCount = this.allFiles.filter(f => f.projectId === null || f.projectId === undefined).length;
          if (this.selectedFile) {
            const refreshed = this.allFiles.find(f => f.id === this.selectedFile!.id);
            this.selectedFile = refreshed ?? null;
            if (this.selectedFile) {
              this.assignmentDraftProjectId = this.selectedFile.projectId ?? null;
              this.lastAssignmentSelection = this.assignmentDraftProjectId;
            } else {
              this.assignmentDraftProjectId = null;
              this.lastAssignmentSelection = null;
            }
          }
          this.applyFilters();
          this.updateStats();
          this.refreshPoleMatches();
        },
        error: (err) => {
          console.error('Error loading files:', err);
          this.allFiles = [];
          this.filteredFiles = [];
          this.refreshPoleMatches();
        }
      });

    this.route.queryParamMap.subscribe((params) => {
      const shouldOpenUpload = params.get('upload');
      if (shouldOpenUpload === '1') {
        const projectIdParam = params.get('projectId');
        if (projectIdParam) {
          const parsed = Number(projectIdParam);
          this.uploadProjectId = Number.isNaN(parsed) ? null : parsed;
        } else {
          this.uploadProjectId = null;
        }
        this.openUploadModal(false);
        void this.router.navigate([], {
          relativeTo: this.route,
          queryParams: { upload: null, projectId: null },
          queryParamsHandling: 'merge',
          replaceUrl: true,
        });
      }
    });
  }

  ngOnDestroy(): void {
    this.pollSubscriptions.forEach(sub => sub.unsubscribe());
    this.pollSubscriptions.clear();
    this.destroy$.next();
    this.destroy$.complete();
    if (this.projectDetailSubscription) {
      this.projectDetailSubscription.unsubscribe();
      this.projectDetailSubscription = undefined;
    }
    this.clearProjectOverlays();
  }

  ngAfterViewInit(): void {
    this.initializeMap();

    // Ensure map renders correctly in full-screen mode
    if (this.selectedProject === 'all' && this.viewMode === 'map') {
      setTimeout(() => {
        if (this.map && this.mapInitialized) {
          this.map.invalidateSize();
          this.fitMapToContent();
        }
      }, 200);
    }
  }

  // ============================================================================
  // KEYBOARD SHORTCUTS
  // ============================================================================

  @HostListener('document:keydown', ['$event'])
  handleKeyboardEvent(event: KeyboardEvent): void {
    // Don't trigger shortcuts if user is typing in an input
    const target = event.target as HTMLElement;
    if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT') {
      // Allow Escape even in inputs
      if (event.key !== 'Escape') {
        return;
      }
    }

    switch (event.key) {
      case 'Escape':
        if (this.selectedFile) {
          this.closeDetailPanel();
          event.preventDefault();
        } else if (this.selectedProjectForNav) {
          this.selectedProjectForNav = null;
          event.preventDefault();
        } else if (this.showUploadModal) {
          this.closeUploadModal();
          event.preventDefault();
        } else if (this.searchQuery) {
          this.clearSearch();
          event.preventDefault();
        }
        break;

      case 'ArrowUp':
        // Handle project navigation in "All Projects" view
        if (this.selectedProject === 'all') {
          if (!this.selectedProjectForNav && this.filteredProjects.length > 0) {
            this.selectedProjectForNav = this.filteredProjects[this.filteredProjects.length - 1];
            this.highlightProjectOnMap(this.selectedProjectForNav);
            event.preventDefault();
          } else if (this.selectedProjectForNav) {
            const currentIndex = this.filteredProjects.findIndex(p => p.id === this.selectedProjectForNav!.id);
            if (currentIndex > 0) {
              this.selectedProjectForNav = this.filteredProjects[currentIndex - 1];
              this.highlightProjectOnMap(this.selectedProjectForNav);
              event.preventDefault();
            }
          }
        } else {
          // Handle file navigation
          if (!this.selectedFile && this.filteredFiles.length > 0) {
            this.selectFile(this.filteredFiles[this.filteredFiles.length - 1]);
            event.preventDefault();
          } else if (this.selectedFile) {
            const currentIndex = this.filteredFiles.findIndex(f => f.id === this.selectedFile!.id);
            if (currentIndex > 0) {
              this.selectFile(this.filteredFiles[currentIndex - 1]);
              event.preventDefault();
            }
          }
        }
        break;

      case 'ArrowDown':
        // Handle project navigation in "All Projects" view
        if (this.selectedProject === 'all') {
          if (!this.selectedProjectForNav && this.filteredProjects.length > 0) {
            this.selectedProjectForNav = this.filteredProjects[0];
            this.highlightProjectOnMap(this.selectedProjectForNav);
            event.preventDefault();
          } else if (this.selectedProjectForNav) {
            const currentIndex = this.filteredProjects.findIndex(p => p.id === this.selectedProjectForNav!.id);
            if (currentIndex < this.filteredProjects.length - 1) {
              this.selectedProjectForNav = this.filteredProjects[currentIndex + 1];
              this.highlightProjectOnMap(this.selectedProjectForNav);
              event.preventDefault();
            }
          }
        } else {
          // Handle file navigation
          if (!this.selectedFile && this.filteredFiles.length > 0) {
            this.selectFile(this.filteredFiles[0]);
            event.preventDefault();
          } else if (this.selectedFile) {
            const currentIndex = this.filteredFiles.findIndex(f => f.id === this.selectedFile!.id);
            if (currentIndex < this.filteredFiles.length - 1) {
              this.selectFile(this.filteredFiles[currentIndex + 1]);
              event.preventDefault();
            }
          }
        }
        break;

      case 'Enter':
        if (this.selectedProjectForNav) {
          this.openProjectFromMap(this.selectedProjectForNav);
          event.preventDefault();
        } else if (this.selectedFile && this.selectedFile.status === 'completed') {
          this.openViewer(this.selectedFile);
          event.preventDefault();
        }
        break;

      case '/':
        // Focus search bar
        const searchInput = document.querySelector('.search-input') as HTMLInputElement;
        if (searchInput && document.activeElement !== searchInput) {
          searchInput.focus();
          event.preventDefault();
        }
        break;
    }
  }

  // ============================================================================
  // DATA LOADING
  // ============================================================================

  loadFiles(): void {
    this.pointCloudService.loadPointClouds();
  }

  applyFilters(): void {
    // Filter projects if in "All Projects" view
    if (this.selectedProject === 'all') {
      let filteredProjects = [...this.projectSummaries];

      // Search filter for projects
      if (this.searchQuery.trim()) {
        const query = this.searchQuery.toLowerCase();
        filteredProjects = filteredProjects.filter(p => {
          const lowerName = (p.name ?? '').toLowerCase();
          const lowerDescription = (p.description ?? '').toLowerCase();
          return lowerName.includes(query) || lowerDescription.includes(query);
        });
      }

      // Sort projects by name
      filteredProjects.sort((a, b) => {
        const comparison = a.name.localeCompare(b.name);
        return this.sortDirection === 'asc' ? comparison : -comparison;
      });

      this.filteredProjects = filteredProjects;

      // Don't filter files in "All Projects" view
      this.filteredFiles = [];
    } else {
      // Filter files for specific project or unassigned
      let filtered = [...this.allFiles].filter(f => f != null);

      // Search filter
      if (this.searchQuery.trim()) {
        const query = this.searchQuery.toLowerCase();
        filtered = filtered.filter(f => {
          const lowerName = f.name.toLowerCase();
          const lowerProject = (f.project ?? '').toLowerCase();
          const lowerLocation = this.getLocationName(f).toLowerCase();
          const isUnassigned = f.projectId === null || f.projectId === undefined;

          return (
            lowerName.includes(query) ||
            (lowerProject && lowerProject.includes(query)) ||
            lowerLocation.includes(query) ||
            (isUnassigned && query.includes('unassigned'))
          );
        });
      }

      // Project filter
      if (this.selectedProject === 'unassigned') {
        filtered = filtered.filter(f => f.projectId === null || f.projectId === undefined);
      } else if (typeof this.selectedProject === 'number') {
        filtered = filtered.filter(f => f.projectId === this.selectedProject);
      }

      // Sort
      filtered.sort((a, b) => {
        let comparison = 0;

        switch (this.sortField) {
          case 'name':
            comparison = a.name.localeCompare(b.name);
            break;
          case 'project':
            comparison = (a.project || '').localeCompare(b.project || '');
            break;
          case 'area':
            comparison = (a.coverageAreaKm2 || 0) - (b.coverageAreaKm2 || 0);
            break;
          case 'points':
            comparison = (a.pointCount || 0) - (b.pointCount || 0);
            break;
        }

        return this.sortDirection === 'asc' ? comparison : -comparison;
      });

      this.filteredFiles = filtered;
      this.filteredProjects = [];
    }

    this.updateMapMarkers();
    this.refreshPoleMatches();
  }

  onSearchChange(): void {
    this.applyFilters();
  }

  clearSearch(): void {
    this.searchQuery = '';
    this.applyFilters();
  }

  updateStats(): void {
    this.totalFiles = this.allFiles.length;

    const totalBytes = this.allFiles.reduce((sum, f) => sum + (f.fileSize || f.size || 0), 0);
    this.totalStorage = this.formatFileSize(totalBytes);
  }

  // ============================================================================
  // INTERACTION
  // ============================================================================

  selectFile(file: PointCloud): void {
    this.selectedFile = file;
    this.assignmentDraftProjectId = file.projectId ?? null;
    this.lastAssignmentSelection = this.assignmentDraftProjectId;
    this.assignmentError = null;

    // Generate 3D preview (placeholder for now)
    if (this.previewCanvas) {
      this.generatePreview(file);
    }

    this.focusMapOnFile(file);
    this.unhighlightAllPolygons();
    this.highlightMapPolygon(file.id);
  }

  closeDetailPanel(): void {
    this.selectedFile = null;
    this.unhighlightAllPolygons();
    this.assignmentDraftProjectId = null;
    this.lastAssignmentSelection = null;
    this.assignmentError = null;
  }

  onRowHover(file: PointCloud): void {
    this.hoveredFileId = file.id;
    this.highlightMapPolygon(file.id);
  }

  onRowLeave(): void {
    this.hoveredFileId = null;
    this.unhighlightAllPolygons();
  }

  filterByProject(projectId: 'all' | 'unassigned' | number): void {
    if (this.selectedProject === projectId) {
      return;
    }
    this.selectedProject = projectId;

    // Auto-switch to map view for "All Projects"
    if (projectId === 'all') {
      this.viewMode = 'map';
      // Clear and reload project markers
      this.clearProjectMarkers();
      this.selectedProjectForNav = null;

      // Invalidate map size and reload project markers after a short delay to ensure map is ready
      setTimeout(() => {
        if (this.map && this.mapInitialized) {
          this.map.invalidateSize();
        }
        this.updateAllProjectsMapView(true); // Force reload
      }, 100);
    } else {
      // Clear project markers when switching to a specific project
      this.clearProjectMarkers();
      this.selectedProjectForNav = null;

      if (this.viewMode === 'map') {
        // Switch to split view when selecting a specific project
        this.viewMode = 'split';

        // Invalidate map size after switching to split view
        if (this.map && this.mapInitialized) {
          setTimeout(() => {
            this.map.invalidateSize();
            this.fitMapToContent();
          }, 100);
        }
      }
    }

    this.applyFilters();
    this.loadProjectContext();
  }

  onSortFieldChange(value: string): void {
    if (
      value !== 'name' &&
      value !== 'project' &&
      value !== 'area' &&
      value !== 'points'
    ) {
      return;
    }

    if (this.sortField === value) {
      return;
    }

    this.sortField = value;
    this.sortDirection = 'asc';
    this.applyFilters();
  }

  toggleSortDirection(): void {
    this.sortDirection = this.sortDirection === 'asc' ? 'desc' : 'asc';
    this.applyFilters();
  }

  setViewMode(mode: 'map' | 'list' | 'split'): void {
    this.viewMode = mode;

    // Invalidate map size when switching to map or split view
    if ((mode === 'map' || mode === 'split') && this.map && this.mapInitialized) {
      setTimeout(() => {
        this.map.invalidateSize();
        this.fitMapToContent();
      }, 100);
    }
  }

  openViewer(file: PointCloud): void {
    if (file.status === 'completed') {
      this.router.navigate(['/viewer', file.id]);
    }
  }

  navigateToProjects(): void {
    this.router.navigate(['/projects']);
  }

  navigateToTrainedModels(): void {
    this.router.navigate(['/trained-models']);
  }

  // ============================================================================
  // POLE NAVIGATION
  // ============================================================================

  get filteredPoleMatches(): PoleMatch[] {
    if (!this.poleSearchQuery.trim()) {
      return this.poleMatches;
    }
    const query = this.poleSearchQuery.trim().toLowerCase();
    return this.poleMatches.filter((match) => {
      const name = (match.pole.name ?? '').toLowerCase();
      const indexLabel = String(match.index + 1);
      const datasetName = match.pointCloud?.name?.toLowerCase() ?? '';
      return (
        name.includes(query) ||
        indexLabel.includes(query) ||
        datasetName.includes(query)
      );
    });
  }

  locatePole(match: PoleMatch): void {
    if (
      !match ||
      !this.map ||
      !this.L ||
      !this.mapInitialized ||
      !this.isValidLatLng(match.pole.lat, match.pole.lng)
    ) {
      return;
    }

    this.activePoleIndex = match.index;
    this.hoverPoleIndex = null;
    this.refreshPoleMarkerStyles(true);
    this.map.flyTo(
      [match.pole.lat, match.pole.lng],
      Math.max(this.map.getZoom(), 15),
      { animate: true, duration: 0.6 }
    );
  }

  onPoleRowHover(match: PoleMatch): void {
    this.hoverPoleIndex = match.index;
    this.refreshPoleMarkerStyles();
  }

  onPoleRowLeave(): void {
    this.hoverPoleIndex = null;
    this.refreshPoleMarkerStyles();
  }

  openPoleInViewer(match: PoleMatch, event?: Event): void {
    if (event) {
      event.stopPropagation();
    }
    if (!match || match.status !== 'ready' || !match.pointCloud) {
      return;
    }
    if (typeof match.pointCloud.id !== 'number') {
      return;
    }

    const poleQuery = match.index;
    this.router.navigate(['/viewer', match.pointCloud.id], {
      queryParams: { pole: poleQuery }
    });
  }

  trackPoleMatch(index: number, match: PoleMatch): number {
    return match?.index ?? index;
  }

  isPoleActive(match: PoleMatch): boolean {
    const highlightedIndex = this.hoverPoleIndex !== null ? this.hoverPoleIndex : this.activePoleIndex;
    return highlightedIndex === match.index;
  }

  private refreshPoleMatches(): void {
    if (
      !this.activeProjectDetail ||
      !Array.isArray(this.activeProjectDetail.poles) ||
      this.selectedProject === 'all' ||
      this.selectedProject === 'unassigned'
    ) {
      this.poleMatches = [];
      return;
    }

    const poles = this.activeProjectDetail.poles;
    if (!poles.length) {
      this.poleMatches = [];
      this.activePoleIndex = null;
      this.hoverPoleIndex = null;
      this.refreshPoleMarkerStyles();
      return;
    }

    const projectPointClouds = Array.isArray(this.activeProjectDetail.pointClouds)
      ? this.activeProjectDetail.pointClouds.slice()
      : [];

    this.poleMatches = poles.map((pole, index) => this.resolvePoleMatch(pole, index, projectPointClouds));
    if (this.activePoleIndex !== null && this.activePoleIndex >= this.poleMatches.length) {
      this.activePoleIndex = null;
    }
    this.refreshPoleMarkerStyles();
  }

  private resolvePoleMatch(pole: ProjectPole, index: number, clouds: PointCloud[]): PoleMatch {
    const validClouds = clouds.filter((cloud) => cloud && typeof cloud.id === 'number');
    const candidate = this.rankPointCloudMatches(pole, validClouds);
    if (!candidate) {
      return {
        pole,
        index,
        pointCloud: null,
        status: 'missing',
        matchType: 'unknown',
        distanceKm: undefined,
        description: 'No dataset coverage yet',
      };
    }

    const canonicalCloud =
      this.allFiles.find((entry) => entry.id === candidate.cloud.id) ??
      candidate.cloud;

    const pointCloudStatus = (canonicalCloud.status ?? '').toLowerCase();
    const status: PoleMatch['status'] =
      pointCloudStatus === 'completed'
        ? 'ready'
        : pointCloudStatus === 'processing'
          ? 'processing'
          : 'missing';

    const description = this.describePoleMatchCandidate(candidate);

    return {
      pole,
      index,
      pointCloud: canonicalCloud,
      status,
      matchType: candidate.matchType,
      distanceKm: candidate.distanceKm,
      description,
    };
  }

  private rankPointCloudMatches(pole: ProjectPole, clouds: PointCloud[]): PoleMatchCandidate | null {
    const candidates: PoleMatchCandidate[] = [];
    for (const cloud of clouds) {
      const evaluated = this.evaluatePoleAgainstPointCloud(pole, cloud);
      if (evaluated) {
        candidates.push(evaluated);
      }
    }

    if (!candidates.length) {
      return null;
    }

    candidates.sort((a, b) => a.score - b.score);
    return candidates[0];
  }

  private evaluatePoleAgainstPointCloud(pole: ProjectPole, cloud: PointCloud): PoleMatchCandidate | null {
    if (!pole || !this.isValidLatLng(pole.lat, pole.lng)) {
      return null;
    }

    const lat = pole.lat;
    const lng = pole.lng;

    if (cloud.footprint && this.isPointInsideFootprint(lat, lng, cloud.footprint)) {
      return {
        cloud,
        matchType: 'footprint',
        score: 0,
      };
    }

    const geographicBounds = this.getPointCloudGeographicBounds(cloud);
    if (geographicBounds && this.isPointInsideBounds(lat, lng, geographicBounds)) {
      return {
        cloud,
        matchType: 'geographic',
        score: 1,
      };
    }

    const approximateBounds = this.getPointCloudApproximateBounds(cloud);
    if (approximateBounds && this.isPointInsideBounds(lat, lng, approximateBounds)) {
      return {
        cloud,
        matchType: 'approximate',
        score: 2,
      };
    }

    const referenceBounds = geographicBounds ?? approximateBounds;
    if (referenceBounds) {
      const center = this.getBoundsCenter(referenceBounds);
      if (center) {
        const distanceKm = this.haversineDistanceKm(lat, lng, center.lat, center.lng);
        if (Number.isFinite(distanceKm)) {
          return {
            cloud,
            matchType: 'nearest',
            score: 10 + distanceKm,
            distanceKm,
          };
        }
      }
    }

    return null;
  }

  private describePoleMatchCandidate(candidate: PoleMatchCandidate): string | null {
    switch (candidate.matchType) {
      case 'footprint':
        return null;
      case 'geographic':
        return 'Inside dataset bounds';
      case 'approximate':
        return 'Using projected bounds';
      case 'nearest': {
        if (typeof candidate.distanceKm === 'number' && Number.isFinite(candidate.distanceKm)) {
          const distanceLabel = this.formatDistance(candidate.distanceKm);
          return `Nearest dataset — ${distanceLabel} offset`;
        }
        return 'Nearest dataset nearby';
      }
      default:
        return null;
    }
  }

  private formatDistance(distanceKm: number): string {
    if (!Number.isFinite(distanceKm) || distanceKm < 0) {
      return '';
    }
    if (distanceKm >= 1) {
      return `${distanceKm.toFixed(1)} km`;
    }
    return `${Math.round(distanceKm * 1000)} m`;
  }

  private refreshPoleMarkerStyles(openTooltip = false): void {
    const highlightedIndex = this.hoverPoleIndex !== null ? this.hoverPoleIndex : this.activePoleIndex;
    this.poleMarkerMap.forEach((marker, index) => {
      const isHighlighted = highlightedIndex === index;
      marker.setStyle({
        color: isHighlighted ? '#facc15' : '#f97316',
        fillColor: isHighlighted ? '#facc15' : '#f97316',
        fillOpacity: isHighlighted ? 0.95 : 0.82,
        radius: isHighlighted ? 6 : 4,
        weight: isHighlighted ? 2 : 1,
      });
      if (isHighlighted && openTooltip && typeof marker.openTooltip === 'function') {
        marker.openTooltip();
      } else if (!isHighlighted && typeof marker.closeTooltip === 'function') {
        marker.closeTooltip();
      }
    });
  }

  private getPointCloudGeographicBounds(
    cloud: PointCloud
  ): { southWest: { lat: number; lng: number }; northEast: { lat: number; lng: number } } | null {
    const geographic = cloud?.bounds?.geographic;
    const sw = geographic?.southWest;
    const ne = geographic?.northEast;
    if (!sw || !ne) {
      return null;
    }

    if (!this.isValidLatLng(sw.lat, sw.lng) || !this.isValidLatLng(ne.lat, ne.lng)) {
      return null;
    }

    return {
      southWest: { lat: sw.lat, lng: sw.lng },
      northEast: { lat: ne.lat, lng: ne.lng },
    };
  }

  private getPointCloudApproximateBounds(
    cloud: PointCloud
  ): { southWest: { lat: number; lng: number }; northEast: { lat: number; lng: number } } | null {
    const minCorner = cloud.bounds?.min;
    const maxCorner = cloud.bounds?.max;
    if (!minCorner || !maxCorner) {
      return null;
    }

    const approximate = this.approximateProjectedBoundsToLatLng(minCorner, maxCorner);
    if (!approximate) {
      return null;
    }

    const [[lat1, lng1], [lat2, lng2]] = approximate;
    if (!this.isValidLatLng(lat1, lng1) || !this.isValidLatLng(lat2, lng2)) {
      return null;
    }

    return {
      southWest: {
        lat: Math.min(lat1, lat2),
        lng: Math.min(lng1, lng2),
      },
      northEast: {
        lat: Math.max(lat1, lat2),
        lng: Math.max(lng1, lng2),
      },
    };
  }

  private isPointInsideBounds(
    lat: number,
    lng: number,
    bounds: { southWest: { lat: number; lng: number }; northEast: { lat: number; lng: number } }
  ): boolean {
    const minLat = Math.min(bounds.southWest.lat, bounds.northEast.lat);
    const maxLat = Math.max(bounds.southWest.lat, bounds.northEast.lat);
    const minLng = Math.min(bounds.southWest.lng, bounds.northEast.lng);
    const maxLng = Math.max(bounds.southWest.lng, bounds.northEast.lng);

    return lat >= minLat && lat <= maxLat && lng >= minLng && lng <= maxLng;
  }

  private getBoundsCenter(
    bounds: { southWest: { lat: number; lng: number }; northEast: { lat: number; lng: number } }
  ): { lat: number; lng: number } | null {
    const lat = (bounds.southWest.lat + bounds.northEast.lat) / 2;
    const lng = (bounds.southWest.lng + bounds.northEast.lng) / 2;

    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      return null;
    }

    return { lat, lng };
  }

  private haversineDistanceKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
    if (
      !Number.isFinite(lat1) ||
      !Number.isFinite(lng1) ||
      !Number.isFinite(lat2) ||
      !Number.isFinite(lng2)
    ) {
      return Number.NaN;
    }

    const rad = Math.PI / 180;
    const dLat = (lat2 - lat1) * rad;
    const dLng = (lng2 - lng1) * rad;
    const a =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    const earthRadiusKm = 6371;
    return earthRadiusKm * c;
  }

  private isPointInsideFootprint(lat: number, lng: number, footprint: PointCloudFootprint): boolean {
    if (!footprint) {
      return false;
    }

    const point: [number, number] = [lng, lat];

    if (footprint.type === 'Polygon') {
      return this.isPointInsidePolygon(point, footprint.coordinates);
    }

    if (footprint.type === 'MultiPolygon') {
      return footprint.coordinates.some((polygon) => this.isPointInsidePolygon(point, polygon));
    }

    return false;
  }

  private isPointInsidePolygon(point: [number, number], polygon: number[][][]): boolean {
    if (!Array.isArray(polygon) || !polygon.length) {
      return false;
    }

    const [outerRing, ...holes] = polygon;
    if (!this.isPointInsideRing(point, outerRing)) {
      return false;
    }

    for (const hole of holes) {
      if (this.isPointInsideRing(point, hole)) {
        return false;
      }
    }

    return true;
  }

  private isPointInsideRing(point: [number, number], ring: number[][]): boolean {
    if (!Array.isArray(ring) || ring.length < 3) {
      return false;
    }

    let inside = false;
    const [x, y] = point;

    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const xi = ring[i][0];
      const yi = ring[i][1];
      const xj = ring[j][0];
      const yj = ring[j][1];

      if ((yi > y) === (yj > y)) {
        continue;
      }

      const denominator = yj - yi;
      if (Math.abs(denominator) < 1e-12) {
        continue;
      }

      const projection = ((xj - xi) * (y - yi)) / denominator + xi;
      if (x < projection) {
        inside = !inside;
      }
    }

    return inside;
  }

  getProjectName(projectId: number | 'all' | 'unassigned' | null): string {
    if (projectId === 'all') {
      return 'All Projects';
    }
    if (projectId === 'unassigned' || projectId === null) {
      return 'Unassigned';
    }
    const project = this.projectSummaries.find((p) => p.id === projectId);
    return project ? project.name : `Project ${projectId}`;
  }

  downloadFile(file: PointCloud): void {
    if (file.url) {
      window.open(file.url, '_blank');
    }
  }

  isDeleting(file?: PointCloud | null): boolean {
    if (!file?.id) {
      return false;
    }
    return this.deletingPointCloudIds.has(file.id);
  }

  deleteFile(file: PointCloud | null, event?: MouseEvent): void {
    event?.stopPropagation();

    if (!file?.id) {
      return;
    }

    const confirmed = window.confirm(`Delete ${file.name}? This action cannot be undone.`);
    if (!confirmed) {
      return;
    }

    this.deletingPointCloudIds.add(file.id);

    this.pointCloudService.deletePointCloud(file.id).subscribe({
      next: () => {
        this.deletingPointCloudIds.delete(file.id);
        this.allFiles = this.allFiles.filter(f => f.id !== file.id);
        this.selectedFile = this.selectedFile?.id === file.id ? null : this.selectedFile;
        this.applyFilters();
        this.pointCloudService.loadPointClouds();
      },
      error: err => {
        console.error('Failed to delete point cloud', err);
        this.deletingPointCloudIds.delete(file.id);
        window.alert('Failed to delete dataset. Please try again.');
      }
    });
  }

  assignFileToProject(file: PointCloud | null): void {
    if (!file || this.isAssigningProject) {
      return;
    }

    const targetProjectIdRaw = this.assignmentDraftProjectId;
    const targetProjectId = targetProjectIdRaw ?? null;
    const currentProjectId = file.projectId ?? null;

    if (targetProjectId !== null && Number.isNaN(targetProjectId)) {
      this.assignmentError = 'Invalid project selection.';
      return;
    }

    if (targetProjectId === currentProjectId) {
      // Nothing changed; silently ignore the request.
      return;
    }

    this.isAssigningProject = true;
    this.assignmentError = null;

    this.projectService
      .assignPointCloudToProject(file.id, targetProjectId)
      .pipe(takeUntil(this.destroy$))
      .subscribe({
        next: () => {
          this.isAssigningProject = false;
          const projectName = targetProjectId === null ? undefined : this.getProjectName(targetProjectId);

          this.allFiles = this.allFiles.map((entry) => {
            if (entry.id !== file.id) {
              return entry;
            }
            const updated: PointCloud = {
              ...entry,
              projectId: targetProjectId,
              project: projectName ?? undefined,
            };
            return updated;
          });
          this.lastAssignmentSelection = targetProjectId;

          if (this.selectedFile?.id === file.id) {
            this.selectedFile = {
              ...this.selectedFile,
              projectId: targetProjectId,
              project: projectName ?? undefined,
            };
            this.assignmentDraftProjectId = targetProjectId;
            this.lastAssignmentSelection = targetProjectId;
          }

          if (currentProjectId === null && targetProjectId !== null) {
            this.unassignedCount = Math.max(0, this.unassignedCount - 1);
          } else if (currentProjectId !== null && targetProjectId === null) {
            this.unassignedCount += 1;
          }

          this.applyFilters();
          this.updateStats();
          this.pointCloudService.loadPointClouds();
          if (this.selectedProject !== 'all'
            && this.selectedProject !== 'unassigned'
            && typeof this.selectedProject === 'number'
            && targetProjectId === this.selectedProject) {
            this.projectService.selectProject(this.selectedProject);
          }
        },
        error: (err) => {
          console.error('Failed to assign point cloud to project', err);
          this.isAssigningProject = false;
          this.assignmentError = 'Failed to update project assignment. Please try again.';
          this.assignmentDraftProjectId = currentProjectId;
          this.lastAssignmentSelection = currentProjectId;
        }
      });
  }

  onAssignmentSelectionChange(value: number | null): void {
    this.assignmentError = null;

    if (value === null) {
      this.assignmentDraftProjectId = null;
      this.lastAssignmentSelection = null;
      return;
    }

    this.assignmentDraftProjectId = value;
    this.lastAssignmentSelection = value;
  }

  getProjectDisplay(file: PointCloud | null): string {
    if (!file) {
      return 'Unassigned';
    }
    if (file.projectId === null || file.projectId === undefined) {
      return 'Unassigned';
    }
    if (file.project && file.project.trim().length > 0) {
      return file.project;
    }
    return this.getLocationName(file);
  }

  // ============================================================================
  // UPLOAD
  // ============================================================================

  openUploadModal(resetSelection: boolean = true): void {
    this.showUploadModal = true;
    if (resetSelection && !this.isUploadQueueProcessing && this.uploadQueue.length === 0) {
      this.uploadProjectId = null;
    }
  }

  closeUploadModal(): void {
    this.showUploadModal = false;
    void this.router.navigate([], {
      relativeTo: this.route,
      queryParams: { upload: null, projectId: null },
      queryParamsHandling: 'merge',
      replaceUrl: true,
    });
  }

  onFileDrop(event: DragEvent): void {
    event.preventDefault();
    const files = Array.from(event.dataTransfer?.files || []);
    this.addFilesToQueue(files);
  }

  onDragOver(event: DragEvent): void {
    event.preventDefault();
  }

  onFileSelect(event: Event): void {
    const input = event.target as HTMLInputElement;
    if (input.files) {
      this.addFilesToQueue(Array.from(input.files));
    }
  }

  removeUploadFile(index: number): void {
    const item = this.uploadQueue[index];
    if (!item || item.status !== 'pending') {
      return;
    }
    this.uploadQueue.splice(index, 1);
  }

  startUpload(): void {
    if (this.isUploadQueueProcessing) {
      return;
    }

    const nextPendingIndex = this.uploadQueue.findIndex(item => item.status === 'pending');
    if (nextPendingIndex === -1) {
      return;
    }

    this.uploadQueue
      .filter(item => item.status === 'pending')
      .forEach(item => {
        item.targetProjectId = this.uploadProjectId;
      });

    this.isUploadQueueProcessing = true;
    this.processNextUpload(nextPendingIndex);
  }

  private addFilesToQueue(files: File[]): void {
    if (!files.length) {
      return;
    }

    const allowedExtensions = new Set(['las', 'laz']);
    const existingKeys = new Set(this.uploadQueue.map(item => `${item.file.name}:${item.file.size}`));

    files.forEach(file => {
      const extension = file.name.split('.').pop()?.toLowerCase() ?? '';
      if (!allowedExtensions.has(extension)) {
        return;
      }

      const key = `${file.name}:${file.size}`;
      if (existingKeys.has(key)) {
        return;
      }

      this.uploadQueue.push({
        file,
        progress: 0,
        status: 'pending',
        targetProjectId: this.uploadProjectId,
      });
      existingKeys.add(key);
    });
  }

  private processNextUpload(startIndex: number): void {
    const currentIndex = this.uploadQueue.findIndex((item, idx) => idx >= startIndex && item.status === 'pending');

    if (currentIndex === -1) {
      this.isUploadQueueProcessing = false;
      this.projectService.loadProjects();
      return;
    }

    const queueItem = this.uploadQueue[currentIndex];
    queueItem.status = 'uploading';
    queueItem.progress = 0;
    queueItem.error = undefined;

    this.pointCloudService
      .addPointCloud(queueItem.file, queueItem.targetProjectId)
      .pipe(takeUntil(this.destroy$))
      .subscribe({
        next: (event) => {
          const progress = Math.round(event.progress ?? 0);
          queueItem.progress = progress;

          if (event.state === 'uploading') {
            queueItem.status = 'uploading';
          }

          if (event.state === 'uploaded') {
            queueItem.progress = 100;
            queueItem.status = 'processing';

            const pointCloudId = event.response?.pointcloud_id;
            if (typeof pointCloudId === 'number') {
              queueItem.pointCloudId = pointCloudId;
              this.pollProcessingStatus(queueItem, currentIndex);
            } else {
              queueItem.status = 'completed';
              this.projectService.loadProjects();
              this.processNextUpload(currentIndex + 1);
            }
          }
        },
        error: (err) => {
          console.error('Upload failed', err);
          queueItem.status = 'failed';
          queueItem.error = err?.message ?? 'Upload failed';
          this.projectService.loadProjects();
          this.processNextUpload(currentIndex + 1);
        }
      });
  }

  private pollProcessingStatus(item: UploadQueueItem, index: number): void {
    if (!item.pointCloudId) {
      item.status = 'completed';
      this.projectService.loadProjects();
      this.processNextUpload(index + 1);
      return;
    }

    const subscription = this.pointCloudService
      .watchPointCloudStatus(item.pointCloudId)
      .pipe(takeUntil(this.destroy$))
      .subscribe({
        next: (pointCloud) => {
          if (pointCloud.status === 'processing') {
            item.status = 'processing';
            return;
          }

          if (pointCloud.status === 'completed') {
            item.status = 'completed';
            item.error = undefined;
            this.projectService.loadProjects();
            subscription.unsubscribe();
            this.pollSubscriptions.delete(item.pointCloudId!);
            this.processNextUpload(index + 1);
          } else if (pointCloud.status === 'failed') {
            item.status = 'failed';
            item.error = pointCloud.errorMessage ?? 'Processing failed.';
            subscription.unsubscribe();
            this.pollSubscriptions.delete(item.pointCloudId!);
            this.projectService.loadProjects();
            this.processNextUpload(index + 1);
          }
        },
        error: (err) => {
          console.error('Failed to poll point cloud status', err);
          item.status = 'failed';
          item.error = 'Processing status unknown. Please check the library.';
          subscription.unsubscribe();
          this.pollSubscriptions.delete(item.pointCloudId!);
          this.projectService.loadProjects();
          this.processNextUpload(index + 1);
        }
      });

    this.pollSubscriptions.set(item.pointCloudId, subscription);
  }

  get hasPendingUploads(): boolean {
    return this.uploadQueue.some(item => item.status === 'pending');
  }

  get hasActiveUploads(): boolean {
    return this.uploadQueue.some(item => item.status === 'uploading' || item.status === 'processing');
  }

  getUploadStatusLabel(item: UploadQueueItem): string {
    switch (item.status) {
      case 'pending':
        return 'Waiting to upload';
      case 'uploading':
        return `Uploading… ${item.progress}%`;
      case 'processing':
        return 'Processing on server';
      case 'completed':
        return 'Available in library';
      case 'failed':
        return item.error ?? 'Upload failed';
      default:
        return '';
    }
  }

  get pendingUploadCount(): number {
    return this.uploadQueue.filter(item => item.status === 'pending').length;
  }

  get completedUploadCount(): number {
    return this.uploadQueue.filter(item => item.status === 'completed').length;
  }


  // ============================================================================
  // 3D PREVIEW (Placeholder)
  // ============================================================================

  generatePreview(file: PointCloud): void {
    if (!this.previewCanvas) return;

    const canvas = this.previewCanvas.nativeElement;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // Placeholder: draw gradient
    const gradient = ctx.createLinearGradient(0, 0, 0, 200);
    gradient.addColorStop(0, '#1f2937');
    gradient.addColorStop(1, '#111827');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, 288, 200);

    ctx.fillStyle = '#ffffff';
    ctx.font = '12px Inter';
    ctx.textAlign = 'center';
    ctx.fillText('3D Preview Coming Soon', 144, 100);
  }

  // ============================================================================
  // FORMATTING HELPERS
  // ============================================================================

  formatArea(file: PointCloud): string {
    if (this.areaDisplayUnit === 'imperial') {
      // Imperial units (ft² and acres)
      const sqft = file.coverageAreaSqft;
      if (!sqft) return '—';

      // 1 acre = 43,560 ft²
      const acres = sqft / 43560;

      // Show acres if >= 0.1 acre, otherwise show ft²
      if (acres >= 0.1) {
        return `${acres.toFixed(2)} ac`;
      } else {
        return `${sqft.toLocaleString('en-US', { maximumFractionDigits: 0 })} ft²`;
      }
    } else {
      // Metric units (km² and hectares)
      const areaKm2 = file.coverageAreaKm2;
      if (!areaKm2) return '—';

      // Show km² if >= 1, otherwise show hectares
      return areaKm2 >= 1
        ? `${areaKm2.toFixed(1)} km²`
        : `${(areaKm2 * 100).toFixed(0)} ha`;
    }
  }

  toggleAreaUnit(): void {
    this.areaDisplayUnit = this.areaDisplayUnit === 'metric' ? 'imperial' : 'metric';
  }

  formatPoints(count?: number): string {
    if (!count) return '—';
    if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
    if (count >= 1_000) return `${(count / 1_000).toFixed(1)}K`;
    return count.toString();
  }

  formatFileSize(bytes: number): string {
    if (bytes >= 1_000_000_000_000) return `${(bytes / 1_000_000_000_000).toFixed(1)} TB`;
    if (bytes >= 1_000_000_000) return `${(bytes / 1_000_000_000).toFixed(1)} GB`;
    if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(1)} MB`;
    if (bytes >= 1_000) return `${(bytes / 1_000).toFixed(1)} KB`;
    return `${bytes} B`;
  }

  formatCoord(coord?: number | null): string {
    if (coord === undefined || coord === null || Number.isNaN(coord)) {
      return '—';
    }
    return coord.toFixed(2);
  }

  formatDensity(density?: number): string {
    if (!density) return '—';
    return `${density.toFixed(1)} pts/m²`;
  }

  getShortCoordSystem(file: PointCloud): string {
    const full = this.getCoordinateSystemDisplay(file);
    return full.split('(')[0].trim();
  }

  getClassificationSummary(file?: PointCloud): string {
    if (!file?.classification) return '—';

    const classes = Object.keys(file.classification);
    if (classes.length === 0) return 'Unclassified';
    if (classes.length === 1) return classes[0];
    return `${classes.length} classes`;
  }

  getQualityTier(file: PointCloud): string {
    const score = this.calculateQualityScore(file);
    if (score >= 85) return 'excellent';
    if (score >= 70) return 'good';
    return 'fair';
  }

  calculateQualityScore(pointCloud: PointCloud): number {
    if (pointCloud.qualityScore !== undefined) {
      return pointCloud.qualityScore;
    }

    let score = 50;

    if (pointCloud.pointCount) {
      const countScore = Math.min(25, (pointCloud.pointCount / 10000000) * 25);
      score += countScore;
    }

    if (pointCloud.pointDensityPerM2) {
      const densityScore = Math.min(20, (pointCloud.pointDensityPerM2 / 30) * 20);
      score += densityScore;
    }

    if (pointCloud.classificationCompleteness) {
      score += (pointCloud.classificationCompleteness / 100) * 15;
    }

    if (pointCloud.status === 'completed') {
      score += 10;
    }

    return Math.round(Math.max(0, Math.min(100, score)));
  }

  getLocationName(pointCloud: PointCloud | null): string {
    if (!pointCloud) return '—';

    if (pointCloud.location) {
      return pointCloud.location;
    }

    const name = pointCloud.name.toLowerCase();

    if (name.includes('hce-smc')) return 'South Mountain Complex';
    if (name.includes('hce-cor')) return 'Corridor Survey';
    if (name.includes('hce-brg')) return 'Bridge Survey';

    return pointCloud.name.replace(/\.(las|laz)$/i, '').replace(/[-_]/g, ' ');
  }

  getCoordinateSystemDisplay(pointCloud: PointCloud): string {
    if (pointCloud.coordinateSystem) {
      return pointCloud.coordinateSystem;
    }

    const boundsCrs = pointCloud.bounds?.coordinateSystem;
    if (boundsCrs) {
      return boundsCrs;
    }

    const name = pointCloud.name.toLowerCase();
    if (name.includes('hce-smc') || name.includes('hce-cor')) {
      return 'UTM 13N (EPSG:32613)';
    }

    return 'UTM 13N';
  }

  // ============================================================================
  // MAP FUNCTIONALITY
  // ============================================================================

  async initializeMap(): Promise<void> {
    if (!this.mapElement || this.mapInitialized) return;

    try {
      // Dynamically import Leaflet
      const L = await import('leaflet');
      this.L = L.default || L;

      // Fix icon paths for Leaflet
      if (this.L.Icon && this.L.Icon.Default) {
        delete (this.L.Icon.Default.prototype as any)._getIconUrl;
        this.L.Icon.Default.mergeOptions({
          iconRetinaUrl: '/leaflet/marker-icon-2x.png',
          iconUrl: '/leaflet/marker-icon.png',
          shadowUrl: '/leaflet/marker-shadow.png',
        });
      }

      // Initialize map centered on Colorado (approximate center of UTM 13N zone)
      this.map = this.L.map(this.mapElement.nativeElement, {
        center: [39.5, -105.5],
        zoom: 10,
        zoomControl: true,
        attributionControl: false
      });

      // Add dark tile layer for premium look
      this.L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
        maxZoom: 19,
        subdomains: 'abcd'
      }).addTo(this.map);

      // Create custom panes for z-index control
      // Default panes: tilePane(200), overlayPane(400), shadowPane(500), markerPane(600), tooltipPane(650), popupPane(700)
      // Create a pane for file polygons that renders above poles (overlayPane)
      this.map.createPane('filePane');
      this.map.getPane('filePane').style.zIndex = 450; // Above overlayPane (400) where poles are

      this.mapInitialized = true;
      console.log('Map initialized successfully');
      this.updateMapMarkers();
      this.updateProjectOverlays();

      // Load project markers if in "All Projects" view
      if (this.selectedProject === 'all') {
        this.updateAllProjectsMapView();
      }
    } catch (error) {
      console.error('Failed to initialize map:', error);
    }
  }

  toggleMapLayer(layer: 'geometry' | 'poles'): void {
    this.mapLayerVisibility[layer] = !this.mapLayerVisibility[layer];
    this.syncProjectLayerVisibility();
  }

  updateMapMarkers(): void {
    if (!this.map || !this.L || !this.mapInitialized) {
      console.log('Map not ready yet, skipping marker update');
      return;
    }

    // Don't show individual file markers in "All Projects" view
    if (this.selectedProject === 'all') {
      // Clear any existing file polygons
      this.filePolygons.forEach(polygon => this.map.removeLayer(polygon));
      this.filePolygons.clear();
      return;
    }

    console.log(`[updateMapMarkers] Updating markers for ${this.filteredFiles.length} files`);

    // Clear existing polygons
    this.filePolygons.forEach(polygon => this.map.removeLayer(polygon));
    this.filePolygons.clear();

    const aggregateBounds = this.L.latLngBounds([]);

    // Add polygons for each filtered file with bounds
    this.filteredFiles.forEach(file => {
      console.log(`[updateMapMarkers] Processing file ${file.id} (${file.name})`);
      let layer = this.createFootprintLayer(file);

      if (!layer) {
        console.log(`[updateMapMarkers] No footprint layer, falling back to rectangle for file ${file.id}`);
        const latLngBounds = this.getLatLngBoundsForFile(file);
        if (!latLngBounds) {
          console.warn(`[updateMapMarkers] No bounds available for file ${file.id}`);
          return;
        }

        layer = this.L.rectangle(latLngBounds, {
          pane: 'filePane', // Use custom pane for higher z-index
          color: '#0ea5e9',
          fillColor: '#0ea5e9',
          fillOpacity: 0.25,
          weight: 2,
          opacity: 1,
        });
        console.log(`[updateMapMarkers] Created rectangle for file ${file.id}`);
      } else {
        console.log(`[updateMapMarkers] ✓ Using footprint layer for file ${file.id}`);
      }

      layer.on('click', () => this.selectFile(file));
      layer.on('mouseover', () => this.onRowHover(file));
      layer.on('mouseout', () => this.onRowLeave());

      layer.addTo(this.map);
      this.filePolygons.set(file.id, layer);
      aggregateBounds.extend(layer.getBounds());
    });

    console.log(`Added ${this.filePolygons.size} polygons to map from ${this.filteredFiles.length} filtered files`);

    this.currentRectBounds = aggregateBounds.isValid() ? aggregateBounds : null;

    if (this.selectedFile) {
      this.highlightMapPolygon(this.selectedFile.id);
    }

    this.fitMapToContent();
  }

  highlightMapPolygon(fileId: number): void {
    const polygon = this.filePolygons.get(fileId);
    if (polygon) {
      polygon.setStyle({
        color: '#10b981',
        fillColor: '#10b981',
        fillOpacity: 0.3,
        weight: 3,
        opacity: 1
      });
      polygon.bringToFront();
    }
  }

  unhighlightAllPolygons(): void {
    this.filePolygons.forEach(polygon => {
      polygon.setStyle({
        color: '#6366f1',
        fillColor: '#6366f1',
        fillOpacity: 0.15,
        weight: 2,
        opacity: 0.6
      });
    });
  }

  private focusMapOnFile(file: PointCloud): void {
    if (!this.map || !this.L || !this.mapInitialized) {
      return;
    }

    const existingLayer = this.filePolygons.get(file.id);
    const layerBounds = existingLayer && typeof (existingLayer as any).getBounds === 'function'
      ? (existingLayer as any).getBounds()
      : null;
    let bounds = layerBounds;

    if (!bounds || !bounds.isValid()) {
      const latLngBounds = this.getLatLngBoundsForFile(file);
      if (!latLngBounds) {
        return;
      }
      bounds = this.L.latLngBounds(latLngBounds);
    }

    if (bounds.isValid()) {
      this.map.fitBounds(bounds, { padding: [40, 40] });
    }
  }

  private getLatLngBoundsForFile(file: PointCloud): [[number, number], [number, number]] | null {
    const bounds = file.bounds;
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
          [ne.lat, ne.lng]
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

  private approximateProjectedBoundsToLatLng(
    min: PointCloudBoundsCorner,
    max: PointCloudBoundsCorner
  ): [[number, number], [number, number]] | null {
    if (
      !this.L ||
      typeof min.x !== 'number' ||
      typeof min.y !== 'number' ||
      typeof max.x !== 'number' ||
      typeof max.y !== 'number'
    ) {
      return null;
    }

    // Fallback approximation assuming UTM-like projection when explicit geographic bounds are unavailable.
    const centralMeridian = -105;
    const falseEasting = 500000;
    const k0 = 0.9996;

    const x1 = (min.x - falseEasting) / k0;
    const x2 = (max.x - falseEasting) / k0;
    const y1 = min.y / k0;
    const y2 = max.y / k0;

    const lat1 = (y1 / 111320) - 0.5;
    const lat2 = (y2 / 111320) - 0.5;
    const lng1 = centralMeridian + (x1 / (111320 * Math.cos((lat1 * Math.PI) / 180)));
    const lng2 = centralMeridian + (x2 / (111320 * Math.cos((lat2 * Math.PI) / 180)));

    return [
      [lat1, lng1],
      [lat2, lng2]
    ];
  }

  private createFootprintLayer(file: PointCloud): any | null {
    if (!this.L || !file?.footprint) {
      return null;
    }

    try {
      const layer = this.L.geoJSON(file.footprint as any, {
        pane: 'filePane',
        style: {
          color: '#0ea5e9',
          fillColor: '#0ea5e9',
          fillOpacity: 0.25,
          weight: 2,
          opacity: 1,
        },
      });

      const layerBounds = layer.getBounds();
      if (!layerBounds || !layerBounds.isValid()) {
        return null;
      }

      return layer;
    } catch (error) {
      console.warn(`Failed to render footprint for file ${file?.id ?? '?'}:`, error);
      return null;
    }
  }

  private isValidLatLng(lat: number | null | undefined, lng: number | null | undefined): boolean {
    return typeof lat === 'number' && Number.isFinite(lat) && typeof lng === 'number' && Number.isFinite(lng);
  }

  private loadProjectContext(): void {
    if (this.projectDetailSubscription) {
      this.projectDetailSubscription.unsubscribe();
      this.projectDetailSubscription = undefined;
    }

    this.poleSearchQuery = '';
    this.activePoleIndex = null;
    this.hoverPoleIndex = null;

    if (this.selectedProject === 'all' || this.selectedProject === 'unassigned') {
      this.activeProjectDetail = null;
      this.clearProjectOverlays();
      this.fitMapToContent();
      this.refreshPoleMatches();
      return;
    }

    const projectId = this.selectedProject;
    if (typeof projectId !== 'number') {
      return;
    }

    this.activeProjectDetail = null;
    this.clearProjectOverlays();
    this.refreshPoleMatches();

    this.projectDetailSubscription = this.projectService
      .fetchProjectDetail(projectId)
      .pipe(takeUntil(this.destroy$))
      .subscribe({
        next: (project) => {
          if (this.selectedProject !== projectId) {
            return;
          }
          this.activeProjectDetail = project;
          this.refreshPoleMatches();
          this.updateProjectOverlays();
        },
        error: (err) => {
          console.error('Failed to load project context:', err);
          if (this.selectedProject === projectId) {
            this.activeProjectDetail = null;
            this.clearProjectOverlays();
            this.fitMapToContent();
            this.refreshPoleMatches();
          }
        }
      });
  }

  private clearProjectOverlays(): void {
    if (this.map) {
      if (this.projectGeometryLayer) {
        this.map.removeLayer(this.projectGeometryLayer);
      }
      if (this.projectPoleLayer) {
        this.map.removeLayer(this.projectPoleLayer);
      }
      if (this.projectCentroidMarker) {
        this.map.removeLayer(this.projectCentroidMarker);
      }
    }
    this.projectGeometryLayer = null;
    this.projectPoleLayer = null;
    this.projectCentroidMarker = null;
    this.projectOverlayBounds = null;
    this.poleMarkerMap.clear();
    this.activePoleIndex = null;
    this.hoverPoleIndex = null;
    this.refreshPoleMarkerStyles();
  }

  private updateProjectOverlays(): void {
    if (!this.map || !this.L || !this.mapInitialized) {
      return;
    }

    this.clearProjectOverlays();

    if (!this.activeProjectDetail) {
      this.fitMapToContent();
      return;
    }

    const boundsAggregate = this.L.latLngBounds([]);
    let hasBounds = false;

    if (this.activeProjectDetail.geometry) {
      try {
        this.projectGeometryLayer = this.L.geoJSON(this.activeProjectDetail.geometry as any, {
          style: {
            color: '#f97316',
            weight: 2,
            fillOpacity: 0.15,
            fillColor: '#fb923c'
          }
        });
        this.applyOverlayVisibility(this.projectGeometryLayer, this.mapLayerVisibility.geometry);

        const geometryBounds = this.projectGeometryLayer.getBounds();
        if (geometryBounds && geometryBounds.isValid()) {
          boundsAggregate.extend(geometryBounds);
          hasBounds = true;
        }
      } catch (error) {
        console.warn('Failed to render project geometry on map:', error);
      }
    }

    if (Array.isArray(this.activeProjectDetail.poles) && this.activeProjectDetail.poles.length > 0) {
      this.poleMarkerMap.clear();
      const markers: any[] = [];

      this.activeProjectDetail.poles.forEach((pole, poleIndex) => {
        if (!this.isValidLatLng(pole.lat, pole.lng)) {
          return;
        }
        const marker = this.L.circleMarker([pole.lat, pole.lng], {
          radius: 4,
          color: '#f97316',
          fillColor: '#f97316',
          fillOpacity: 0.85,
          weight: 1,
        });
        if (pole.name) {
          marker.bindTooltip(pole.name, { direction: 'top', offset: [0, -6] });
        }
        marker.on('mouseover', () => {
          this.hoverPoleIndex = poleIndex;
          this.refreshPoleMarkerStyles();
        });
        marker.on('mouseout', () => {
          this.hoverPoleIndex = null;
          this.refreshPoleMarkerStyles();
        });
        marker.on('click', () => {
          this.activePoleIndex = poleIndex;
          this.hoverPoleIndex = null;
          this.refreshPoleMarkerStyles(true);
          this.map.flyTo([pole.lat, pole.lng], Math.max(this.map.getZoom(), 15), { animate: true, duration: 0.6 });
        });

        markers.push(marker);
        this.poleMarkerMap.set(poleIndex, marker);
      });

      if (markers.length > 0) {
        this.projectPoleLayer = this.L.featureGroup(markers);
        this.applyOverlayVisibility(this.projectPoleLayer, this.mapLayerVisibility.poles);
        const poleBounds = this.projectPoleLayer.getBounds();
        if (poleBounds && poleBounds.isValid()) {
          boundsAggregate.extend(poleBounds);
          hasBounds = true;
        }
      }
      this.refreshPoleMarkerStyles();
    }

    if (this.activeProjectDetail.centroid && this.isValidLatLng(this.activeProjectDetail.centroid.lat, this.activeProjectDetail.centroid.lng)) {
      this.projectCentroidMarker = this.L.circleMarker(
        [this.activeProjectDetail.centroid.lat, this.activeProjectDetail.centroid.lng],
        {
          radius: 6,
          color: '#22c55e',
          fillColor: '#22c55e',
          fillOpacity: 0.9,
          weight: 2,
        }
      ).addTo(this.map);

      boundsAggregate.extend([this.activeProjectDetail.centroid.lat, this.activeProjectDetail.centroid.lng]);
      hasBounds = true;
    }

    this.projectOverlayBounds = hasBounds && boundsAggregate.isValid() ? boundsAggregate : null;
    this.fitMapToContent();
  }

  private syncProjectLayerVisibility(): void {
    if (!this.map || !this.mapInitialized) {
      return;
    }

    this.applyOverlayVisibility(this.projectGeometryLayer, this.mapLayerVisibility.geometry);
    this.applyOverlayVisibility(this.projectPoleLayer, this.mapLayerVisibility.poles);
  }

  private applyOverlayVisibility(layer: any, visible: boolean): void {
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

  private fitMapToContent(): void {
    if (!this.map || !this.L || !this.mapInitialized) {
      return;
    }

    const bounds = this.L.latLngBounds([]);
    let hasBounds = false;

    if (this.currentRectBounds && this.currentRectBounds.isValid()) {
      bounds.extend(this.currentRectBounds);
      hasBounds = true;
    }

    if (this.projectOverlayBounds && this.projectOverlayBounds.isValid()) {
      bounds.extend(this.projectOverlayBounds);
      hasBounds = true;
    }

    if (hasBounds && bounds.isValid()) {
      this.map.fitBounds(bounds, { padding: [50, 50] });
    } else {
      this.map.setView([39.5, -105.5], 6);
    }
  }

  // ============================================================================
  // PROJECT MARKERS & BOTTOM DRAWER
  // ============================================================================

  private updateAllProjectsMapView(forceReload: boolean = false): void {
    if (!this.map || !this.L || !this.mapInitialized) {
      return;
    }

    if (this.selectedProject !== 'all') {
      return;
    }

    // Prevent duplicate calls - only load once (unless force reload)
    if (this.projectMarkersLoaded && !forceReload) {
      return;
    }

    // Don't load if there are no projects yet
    if (this.projectSummaries.length === 0) {
      return;
    }

    // Clear existing project markers
    this.clearProjectMarkers();

    // Mark as loaded to prevent duplicate calls
    this.projectMarkersLoaded = true;

    // Add markers and boundaries for each project
    this.projectSummaries.forEach(project => {
      // Get project detail to access geometry
      this.projectService.fetchProjectDetail(project.id).subscribe({
        next: (detail) => {
          if (detail.geometry) {
            this.addProjectBoundaryAndMarker(project, detail);
          }
        },
        error: (err) => {
          console.error(`Failed to load project ${project.id}:`, err);
        }
      });
    });
  }

  private addProjectBoundaryAndMarker(project: ProjectSummary, detail: ProjectDetail): void {
    if (!this.L || !this.map || !detail.geometry) {
      return;
    }

    // Add boundary polygon
    const boundaryLayer = this.L.geoJSON(detail.geometry as any, {
      style: {
        color: '#f97316',
        weight: 2,
        fillOpacity: 0.15,
        fillColor: '#fb923c'
      }
    });

    boundaryLayer.on('click', () => this.openProjectFromMap(project));
    boundaryLayer.addTo(this.map);
    this.projectBoundaryLayers.set(project.id, boundaryLayer);

    // Calculate centroid and add marker
    const centroid = this.calculateProjectCentroid(detail);
    if (centroid) {
      const marker = this.L.marker([centroid.lat, centroid.lng], {
        icon: this.L.divIcon({
          className: 'project-marker',
          html: `<div class="project-marker__pin"></div><div class="project-marker__label">${project.name}</div>`,
          iconSize: [120, 40],
          iconAnchor: [60, 40]
        })
      });

      marker.on('click', () => this.openProjectFromMap(project));
      marker.addTo(this.map);
      this.projectMarkers.set(project.id, marker);
    }
  }

  private calculateProjectCentroid(detail: ProjectDetail): { lat: number; lng: number } | null {
    // First check if centroid is provided
    if (detail.centroid && this.isValidLatLng(detail.centroid.lat, detail.centroid.lng)) {
      return detail.centroid;
    }

    // Calculate from geometry
    if (!detail.geometry) {
      return null;
    }

    const geometry = detail.geometry as any;
    if (geometry.type === 'Polygon') {
      return this.calculatePolygonCentroid(geometry.coordinates);
    } else if (geometry.type === 'MultiPolygon') {
      // Use first polygon
      return this.calculatePolygonCentroid(geometry.coordinates[0]);
    }

    return null;
  }

  private calculatePolygonCentroid(coordinates: number[][][]): { lat: number; lng: number } | null {
    if (!coordinates || !coordinates[0] || coordinates[0].length === 0) {
      return null;
    }

    const outerRing = coordinates[0];
    let sumLat = 0;
    let sumLng = 0;
    let count = 0;

    for (const coord of outerRing) {
      sumLng += coord[0];
      sumLat += coord[1];
      count++;
    }

    if (count === 0) {
      return null;
    }

    return {
      lat: sumLat / count,
      lng: sumLng / count
    };
  }

  private clearProjectMarkers(): void {
    this.projectMarkers.forEach(marker => this.map.removeLayer(marker));
    this.projectMarkers.clear();

    this.projectBoundaryLayers.forEach(layer => this.map.removeLayer(layer));
    this.projectBoundaryLayers.clear();

    this.projectMarkersLoaded = false;
  }

  openProjectFromMap(project: ProjectSummary): void {
    // Clear project navigation selection
    this.selectedProjectForNav = null;

    // Switch to the selected project and show split view
    this.filterByProject(project.id);
  }

  highlightProjectOnMap(project: ProjectSummary): void {
    if (!this.map || !this.L || !this.mapInitialized) {
      return;
    }

    // Reset all project boundaries to default style
    this.projectBoundaryLayers.forEach((layer, projectId) => {
      layer.setStyle({
        color: '#f97316',
        weight: 2,
        fillOpacity: 0.15,
        fillColor: '#fb923c'
      });
    });

    // Highlight the selected project
    const selectedLayer = this.projectBoundaryLayers.get(project.id);
    if (selectedLayer) {
      selectedLayer.setStyle({
        color: '#10b981',
        weight: 3,
        fillOpacity: 0.25,
        fillColor: '#10b981'
      });
      selectedLayer.bringToFront();

      // Zoom to the project bounds
      const bounds = selectedLayer.getBounds();
      if (bounds && bounds.isValid()) {
        this.map.fitBounds(bounds, { padding: [50, 50] });
      }
    }
  }
}
