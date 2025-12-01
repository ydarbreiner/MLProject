import { Component, ElementRef, ViewChild, AfterViewInit, OnDestroy, HostListener, ChangeDetectionStrategy, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterModule } from '@angular/router';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { MatMenuModule } from '@angular/material/menu';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';
import { MatDialog, MatDialogModule } from '@angular/material/dialog';
import { MatSliderModule } from '@angular/material/slider';
import { MatSelectModule } from '@angular/material/select';
import { MatCardModule } from '@angular/material/card';
import { MatSlideToggleModule } from '@angular/material/slide-toggle';
import {
  FrustumCulledCOPCService,
  ClassificationChangeSummary,
  SelectedPoint,
  PointPickResult,
} from '../../core/services/frustum-culled-copc.service';
import { ApiService } from '../../core/services/api.service';
import { PointCloudService } from '../../core/services/point-cloud.service';
import { MeasurementService, Measurement } from '../../core/services/measurement.service';
import { MenuService } from '../../core/services/menu.service';
import { ClassificationColorService } from '../../core/services/classification-color.service';
import { PointCloud, PointCloudPole, PointCloudPoleUpdateRequest } from '../../core/models/point-cloud.model';
import { filter, take, takeUntil } from 'rxjs/operators';
import { Observable, Subject } from 'rxjs';
import * as THREE from 'three';
import { ClassificationEditRequest } from '../../core/models/classification-edit.models';
import { MenuBarComponent } from './menu-bar/menu-bar.component';
import { KeyboardShortcutsDialogComponent } from './keyboard-shortcuts-dialog/keyboard-shortcuts-dialog.component';
import { ClusterAnalysisService } from '../../core/services/cluster-analysis.service';
import {
  ClusterGenerationJob,
  ClusterJobSummary,
  ClusterOverlayManifestItem,
  ClusterOverlayPayload,
} from '../../core/models/cluster-analysis.models';
import { CameraMode } from '../../core/models/camera-settings.model';

type ClusterJobStageKey = 'queued' | 'training' | 'extracting' | 'clustering' | 'building_overlay';

interface ClusterGenerationJobWithHistory extends ClusterGenerationJob {
  previousStatus?: ClusterGenerationJob['status'];
}

@Component({
  selector: 'app-point-cloud-viewer',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.Default,
  imports: [
    CommonModule,
    FormsModule,
    MatProgressSpinnerModule,
    MatIconModule,
    MatButtonModule,
    MatMenuModule,
    MatTooltipModule,
    MatSnackBarModule,
    MatDialogModule,
    MatSliderModule,
    MatSelectModule,
    MatCardModule,
    MatSlideToggleModule,
    RouterModule,
    MenuBarComponent
  ],
  templateUrl: './point-cloud-viewer.component.html',
  styleUrls: ['./point-cloud-viewer.component.scss']
})
export class PointCloudViewerComponent implements AfterViewInit, OnDestroy, OnInit {
  @ViewChild('renderArea', { static: true })
  renderArea!: ElementRef<HTMLElement>;

  @ViewChild('viewerHost', { static: true })
  viewerHost!: ElementRef<HTMLElement>;

  // Expose Math for template
  Math = Math;


  // Observables
  selectedPointCloud$: Observable<PointCloud | null>;
  isLoading$: Observable<boolean>;
  error$: Observable<string | null>;

  // Component lifecycle
  private destroy$ = new Subject<void>();

  // Color and display settings
  currentColorMode: 'rgb' | 'elevation' | 'classification' | 'intensity' | 'cluster' = 'rgb';
  pointSize: number = 3;

  // Tools
  currentTool: 'lasso' | 'measure' | 'pan' | 'point-info' | null = null;

  // Lasso selection
  lassoPoints: {x: number, y: number}[] = [];
  isLassoActive: boolean = false;

  // Selection feedback
  isSelecting: boolean = false;
  selectionProgress: string = '';
  measurementPoints: THREE.Vector3[] = [];
  measurementScreenPoints: {x: number, y: number}[] = [];
  measurementDistance: number = 0;
  currentMousePos: {x: number, y: number} = {x: 0, y: 0};
  previewDistance: number = 0;
  pointInfoResult: PointInfoSnapshot | null = null;
  pointInfoError: string | null = null;
  savedMeasurements: Array<{
    id: number;
    points: THREE.Vector3[];
    distance: number;
    timestamp: Date;
  }> = [];
  nextMeasurementId: number = 1;
  viewWidth: number = window.innerWidth;
  viewHeight: number = window.innerHeight;
  measurementsPanelOpen: boolean = false;
  selectedMeasurementId: number | null = null;

  // Classification system (dynamically loaded from backend)
  private readonly standardClassificationDefinitions: Classification[] = [
    { id: 1, value: 1, name: 'Unclassified', color: '#9CA3AF', defaultColor: '#9CA3AF', custom: false, pointCount: 0, aliases: ['UNCLASSIFIED', 'UNASSIGNED'], matchValues: [0, 1] },
    { id: 2, value: 2, name: 'Ground', color: '#8B4513', defaultColor: '#8B4513', custom: false, pointCount: 0 },
    { id: 3, value: 3, name: 'Low Veg', color: '#4CAF50', defaultColor: '#4CAF50', custom: false, pointCount: 0, aliases: ['LOW VEGETATION'] },
    { id: 4, value: 4, name: 'Medium Veg', color: '#22C55E', defaultColor: '#22C55E', custom: false, pointCount: 0, aliases: ['MEDIUM VEGETATION'] },
    { id: 5, value: 5, name: 'High Veg', color: '#16A34A', defaultColor: '#16A34A', custom: false, pointCount: 0, aliases: ['HIGH VEGETATION'] },
    { id: 6, value: 6, name: 'Building', color: '#F97316', defaultColor: '#F97316', custom: false, pointCount: 0, aliases: ['BUILDING', 'BUILDINGS'] },
    { id: 7, value: 7, name: 'Noise', color: '#F59E0B', defaultColor: '#F59E0B', custom: false, pointCount: 0, aliases: ['LOW POINT (NOISE)', 'HIGH NOISE'] },
    { id: 8, value: 8, name: 'Model Key-Point', color: '#A855F7', defaultColor: '#A855F7', custom: false, pointCount: 0, aliases: ['MODEL KEY-POINT'] },
    { id: 9, value: 9, name: 'Water', color: '#2563EB', defaultColor: '#2563EB', custom: false, pointCount: 0 },
    { id: 10, value: 12, name: 'Overlap', color: '#C084FC', defaultColor: '#C084FC', custom: false, pointCount: 0, aliases: ['OVERLAP', 'OVERLAP DEFAULT'] },
    { id: 11, value: 13, name: 'Wire Guard', color: '#FACC15', defaultColor: '#FACC15', custom: false, pointCount: 0, aliases: ['WIRE GUARD'] },
    { id: 12, value: 14, name: 'Wire - Conductor', color: '#FDE68A', defaultColor: '#FDE68A', custom: false, pointCount: 0, aliases: ['WIRE - CONDUCTOR', 'CONDUCTOR'] },
    { id: 13, value: 15, name: 'Utility Structure', color: '#FBBF24', defaultColor: '#FBBF24', custom: false, pointCount: 0 },
    { id: 14, value: 16, name: 'Wire - Guy Wire', color: '#FACC15', defaultColor: '#FACC15', custom: false, pointCount: 0, aliases: ['WIRE - GUY WIRE'] },
    { id: 15, value: 17, name: 'Wire - Secondary', color: '#EAB308', defaultColor: '#EAB308', custom: false, pointCount: 0, aliases: ['WIRE - SECONDARY'] }
  ];
  private baseClassificationDefinitions: Classification[] = this.standardClassificationDefinitions.map(def => ({ ...def }));
  classifications: Classification[] = this.baseClassificationDefinitions.map(def => ({ ...def }));

  selectedClassification: Classification | null = this.classifications.find(c => c.value === 2) ?? this.classifications[0];
  selectedSourceClassification: Classification | null = this.classifications[0];
  pendingClassification: PendingClassification | null = null;
  previewPolygon: {x: number, y: number}[] = [];
  private lassoControlsLocked = false;

  // Classification visibility tracking
  classificationVisibility = new Map<number, boolean>();

  // Statistics
  totalPoints: number = 0;
  classifiedPoints: number = 0;
  renderedPoints: number = 0;
  fileSize: number = 0;
  coverageArea: number = 0;
  detailsPanelOpen: boolean = false;

  // Camera orientation
  cameraAzimuth: number = 0; // Rotation around Z axis (0-360)
  cameraPitch: number = 0; // Angle from horizontal (-90 to 90)
  cameraX: number = 0;
  cameraY: number = 0;
  cameraZ: number = 0;

  // Undo/Redo state
  canUndo: boolean = false;
  canRedo: boolean = false;

  // Selection properties

  // RGB adjustment controls
  rgbBrightness: number = 0;
  rgbContrast: number = 100;
  rgbSaturation: number = 100;

  // Camera mode
  cameraMode: CameraMode = 'orbit';

  // Slice mode
  sliceEnabled: boolean = false;
  sliceHeight: number = 0;
  sliceMinHeight: number = 0;
  sliceMaxHeight: number = 100;

  // Clip box mode
  clipBoxEnabled: boolean = false;
  clipBoxRadius: number = 200;

  // X-ray mode
  xrayEnabled: boolean = false;
  xrayOpacity: number = 0.2;

  // Bottom properties panel
  bottomPanelOpen: boolean = false;
  bottomPanelTab: 'general' | 'attributes' | 'statistics' | 'measurements' | 'history' = 'general';

  // Right sidebar (classification panel - only visible in classification mode)
  sidebarOpen: boolean = true;

  // Floating panels
  statisticsPanelOpen: boolean = false;
  settingsPanelOpen: boolean = false;

  // Display settings
  pointBudget: number = 2000000;
  backgroundColor: 'black' | 'white' | 'gray' = 'black';
  isFullscreen: boolean = false;
  fps: number = 60;
  pointDensity: number | null = null;
  edlEnabled: boolean = false;
  hullEnabled: boolean = false;
  private readonly displayPrefsKey = 'pointcloud-viewer-display-prefs';
  classificationColorOverrides: Record<number, string> = {};
  private readonly classificationColorHistoryKey = 'pointcloud-viewer-classification-color-history';
  colorEditingClassification: Classification | null = null;
  classificationColorDraft: string = '#9CA3AF';
  recentClassificationColors: string[] = [];

  // Pole landmarks
  poles: PointCloudPole[] = [];
  selectedPoleId: PointCloudPole['id'] | null = null;
  polePanelOpen: boolean = true;
  poleLoadError: string | null = null;
  polesLoading: boolean = false;
  poleMarkerScale: number = 0.65;
  readonly poleMarkerScaleMin = 0.3;
  readonly poleMarkerScaleMax = 1.6;
  readonly poleMarkerScaleStep = 0.05;
  showPoleLabels: boolean = true;
  private readonly poleGroundSnapTolerance = 4;
  private readonly defaultPoleCameraOffset = 120;
  private poleApproximationNoticeShown = false;
  currentPointCloud: PointCloud | null = null;
  private pendingPoleFocusId: string | number | null = null;
  poleEditState: 'idle' | 'awaiting-point' | 'saving' = 'idle';
  editingPoleId: PointCloudPole['id'] | null = null;

  // Collapsible sections
  sectionsExpanded = {
    quickStats: true,
    toolSettings: true,
    classifications: true,
    viewSettings: false,
    cameraPosition: false,
    measurements: true,
    activity: false
  };

  // Activity log
  activityLog: ActivityLogEntry[] = [];
  maxActivityLog: number = 50;
  classificationSaveStatus: 'idle' | 'queued' | 'saving' | 'success' | 'error' = 'idle';
  lastClassificationOperationId: string | null = null;

  private classificationSaveQueue: ClassificationSaveQueueItem[] = [];
  private failedClassificationSaves: ClassificationSaveQueueItem[] = [];
  private classificationSaveInFlight = false;
  private readonly maxClassificationSaveAttempts = 3;
  private lastClassificationSaveSummary: ClassificationSaveSummary | null = null;
  private activePointCloudId: number | null = null;
  private classificationValueCounts = new Map<number, number>();
  private classificationPalette = new Map<number, THREE.Color>();
  private overridesRefreshHandle: number | null = null;
  private classificationStatusPollHandle: number | null = null;
  classificationStatuses: ClassificationBatchStatus[] = [];
  clusterPanelOpen = false;
  clusterJobsLoading = false;
  clusterJobs: ClusterJobSummary[] = [];
  selectedClusterJob: ClusterJobSummary | null = null;
  overlayManifestItems: ClusterOverlayManifestItem[] = [];
  overlayLoading = false;
  activeOverlayFilePath: string | null = null;
  clusterOverlayActive = false;
  clusterOverlayCounts: Record<number, number> = {};
  private clusterOverlayPalette = new Map<number, THREE.Color>();
  Object = Object; // For template access

  // Cluster generation
  clusterGenerationConfig = {
    numClusters: 12,
    maxTrainingSteps: 2000,
    targetCoverage: 25,  // Default to fast mode (~60 min)
  };
  clusterGenerationInProgress = false;
  jobActionLoading: Record<string, boolean> = {};
  activeGenerationJobs: ClusterGenerationJobWithHistory[] = [];
  private generationJobPollHandle: number | null = null;
  clusterModelMode: 'new' | 'existing' = 'new';
  trainedModels: any[] = [];
  trainedModelsLoading = false;
  selectedModelCheckpoint: string | null = null;

  // Coverage options for cluster generation
  coverageOptions = [
    {
      value: 25,
      label: 'Fast (~60 min)',
      description: '25% model-based coverage, 75% spatial propagation',
      patches: '~100K'
    },
    {
      value: 50,
      label: 'Balanced (~90 min)',
      description: '50% model-based coverage, 50% spatial propagation',
      patches: '~200K'
    },
    {
      value: 75,
      label: 'High (~2 hours)',
      description: '75% model-based coverage, 25% spatial propagation',
      patches: '~300K'
    },
    {
      value: 90,
      label: 'Full (~4 hours)',
      description: '90%+ model-based coverage, minimal spatial propagation',
      patches: '~600K'
    }
  ];
  readonly clusterJobStages: Array<{ key: ClusterJobStageKey; label: string; description: string }> = [
    { key: 'queued', label: 'Queued', description: 'Waiting for worker availability' },
    { key: 'training', label: 'Train Encoder', description: 'Learning local features' },
    { key: 'extracting', label: 'Extract Embeddings', description: 'Sampling patches from the point cloud' },
    { key: 'clustering', label: 'Cluster Points', description: 'Grouping similar embeddings' },
    { key: 'building_overlay', label: 'Build Overlay', description: 'Packing colors for the viewer' },
  ];
  private readonly clusterStageOrder: ClusterJobStageKey[] = this.clusterJobStages.map(stage => stage.key);
  private readonly clusterStatusLabels: Record<ClusterGenerationJob['status'], string> = {
    queued: 'Queued',
    training: 'Training model',
    extracting: 'Extracting embeddings',
    clustering: 'Clustering points',
    building_overlay: 'Building overlay',
    completed: 'Completed',
    failed: 'Failed',
    cancelled: 'Cancelled',
  };
  private readonly clusterStatusIcons: Record<ClusterGenerationJob['status'], string> = {
    queued: 'schedule',
    training: 'science',
    extracting: 'scatter_plot',
    clustering: 'hub',
    building_overlay: 'layers',
    completed: 'check_circle',
    failed: 'error_outline',
    cancelled: 'block',
  };

  get currentClusterRuns(): ClusterGenerationJobWithHistory[] {
    return this.activeGenerationJobs.filter(job => job.status !== 'completed');
  }

  constructor(
    private route: ActivatedRoute,
    private router: Router,
    private pointCloudService: PointCloudService,
    private frustumCulledService: FrustumCulledCOPCService,
    private snackBar: MatSnackBar,
    private api: ApiService,
    private measurementService: MeasurementService,
    private menuService: MenuService,
    private dialog: MatDialog,
    private clusterAnalysis: ClusterAnalysisService,
    private classificationColorService: ClassificationColorService,
  ) {
    this.selectedPointCloud$ = this.pointCloudService.selectedPointCloud$;
    this.isLoading$ = this.pointCloudService.isLoading$;
    this.error$ = this.pointCloudService.error$;

    // Wire up menu event handlers
    this.setupMenuHandlers();
  }

  ngOnInit(): void {
    this.loadDisplayPreferences();
    this.loadClassificationColorHistory();

    // Load global classification color schemes from backend
    this.classificationColorService.loadAllColorSchemes().subscribe(schemes => {
      console.log(`✅ Loaded ${schemes.length} global classification color schemes`);

      // Update baseClassificationDefinitions from loaded schemes
      this.updateClassificationDefinitionsFromSchemes(schemes);

      // If we have a current point cloud, rebuild its classifications
      if (this.currentPointCloud) {
        this.buildClassificationsForPointCloud(this.currentPointCloud);
        this.syncClassificationColorsToService();
      }
    });
  }

  ngAfterViewInit(): void {
    console.log('🎯 Initializing premium point cloud viewer');

    // Initialize frustum-culled COPC viewer
    this.frustumCulledService.initialize(this.viewerHost);
    this.frustumCulledService.setPoleMarkerScale(this.poleMarkerScale);
    this.frustumCulledService.setPoleLabelsVisible(this.showPoleLabels);
    setTimeout(() => this.updateViewportDimensions(), 0);

    // Load point cloud from route parameter
    this.route.params.pipe(take(1)).subscribe(params => {
      const id = params['id'];
      if (id) {
        this.pointCloudService.loadPointCloud(id);
      }
    });

    this.route.queryParamMap
      .pipe(takeUntil(this.destroy$))
      .subscribe((params) => {
        const poleParam = params.get('pole');
        if (poleParam === null || poleParam === undefined || poleParam === '') {
          this.pendingPoleFocusId = null;
          return;
        }

        const parsed = Number(poleParam);
        this.pendingPoleFocusId = Number.isNaN(parsed) ? poleParam : parsed;
        this.tryFocusOnPendingPole();
      });

    // Listen for point cloud changes
    this.selectedPointCloud$.pipe(
      filter(pc => pc !== null),
      takeUntil(this.destroy$)
    ).subscribe(pointCloud => {
      const pc = pointCloud!;
      this.activePointCloudId = pc.id ?? null;
      this.currentPointCloud = pc;
      this.refreshClassificationsForPointCloud(pc);
      this.resetClusterOverlayState();
      this.loadPointCloudInViewer(pc);
      this.totalPoints = pc.pointCount || 0;
      this.initializeClassificationCounts(pc);
      this.loadPolesForPointCloud(pc);
      this.loadMeasurementsFromBackend(pc.id);
      this.loadClusterJobsForCurrentPointCloud();
    });

    // Start undo/redo state updates
    this.startUndoRedoStateUpdate();
  }

  ngOnDestroy(): void {
    // Clear the shared selection so reopening the viewer does not replay a stale dataset
    this.pointCloudService.clearPointCloud();
    this.destroy$.next();
    this.destroy$.complete();
    if (this.overridesRefreshHandle !== null) {
      window.clearTimeout(this.overridesRefreshHandle);
      this.overridesRefreshHandle = null;
    }
    if (this.classificationStatusPollHandle !== null) {
      window.clearTimeout(this.classificationStatusPollHandle);
      this.classificationStatusPollHandle = null;
    }
    if (this.generationJobPollHandle !== null) {
      window.clearTimeout(this.generationJobPollHandle);
      this.generationJobPollHandle = null;
    }
    this.resetPoleState();
    this.cancelPendingClassification(false);
    this.frustumCulledService.clearClassificationOverrides();
    this.frustumCulledService.destroy();
  }

  private setupMenuHandlers(): void {
    // Subscribe to menu events
    this.menuService.onExportScreenshotRequested()
      .pipe(takeUntil(this.destroy$))
      .subscribe(() => this.captureScreenshot());

    this.menuService.onExportMeasurementsRequested()
      .pipe(takeUntil(this.destroy$))
      .subscribe(() => this.exportMeasurements());

    this.menuService.onShowKeyboardShortcutsRequested()
      .pipe(takeUntil(this.destroy$))
      .subscribe(() => {
        this.dialog.open(KeyboardShortcutsDialogComponent, {
          width: '800px',
          maxWidth: '90vw',
          panelClass: 'keyboard-shortcuts-dialog-panel'
        });
      });

    this.menuService.onShowAboutRequested()
      .pipe(takeUntil(this.destroy$))
      .subscribe(() => {
        this.snackBar.open('Point Cloud Viewer v1.0.0', 'Close', {
          duration: 5000
        });
      });

    this.menuService.onCameraViewRequested()
      .pipe(takeUntil(this.destroy$))
      .subscribe((view) => {
        switch (view) {
          case 'reset':
            this.resetView();
            break;
          case 'top':
          case 'front':
          case 'side':
          case 'isometric':
            // Will be implemented when we extend FrustumCulledCOPCService
            console.log('Camera view requested:', view);
            break;
        }
      });

    // Update menu state when point cloud changes
    this.selectedPointCloud$
      .pipe(takeUntil(this.destroy$))
      .subscribe((pointCloud) => {
        this.menuService.updateMenuState({
          hasPointCloud: !!pointCloud
        });
      });
  }

  private loadPointCloudInViewer(pointCloud: PointCloud): void {
    this.frustumCulledService.initialized$.pipe(
      filter(initialized => initialized),
      take(1)
    ).subscribe(() => {
      if (pointCloud.url) {
        const fullUrl = pointCloud.url.startsWith('http')
          ? pointCloud.url
          : `http://localhost:8000${pointCloud.url}`;

        console.log('🎯 Loading COPC point cloud:', fullUrl);
        this.frustumCulledService.clearClassificationOverrides();
        this.frustumCulledService.clearPoleMarkers();
        const currentPointCloudId = pointCloud.id ?? null;
        void this.frustumCulledService.loadPointCloud(fullUrl, pointCloud.name)
          .then(() => {
            if (this.activePointCloudId !== currentPointCloudId) {
              return;
            }
            // Reapply classification palette once the point cloud is ready
            if (this.currentColorMode === 'classification') {
              this.syncClassificationColorsToService();
              this.frustumCulledService.refreshClassificationColorLUT();
            }
            this.refreshPoleMarkersAfterPointCloudLoad();
          })
          .catch(error => {
            console.error('Failed to load COPC point cloud:', error);
          });

        // Update file stats
        this.fileSize = pointCloud.fileSize || pointCloud.size || 0;
        this.coverageArea = pointCloud.coverageAreaKm2 || 0;

        // Start updating render stats
        this.startStatsUpdate();
      }
    });
  }

  // Navigation
  navigateBack(): void {
    this.router.navigate(['/point-clouds']);
  }

  togglePolePanel(): void {
    this.polePanelOpen = !this.polePanelOpen;
    if (this.polePanelOpen) {
      this.statisticsPanelOpen = false;
      this.settingsPanelOpen = false;
      this.measurementsPanelOpen = false;
    }
  }

  focusOnPole(pole: PointCloudPole): void {
    if (!pole) {
      return;
    }

    if (!this.poleIdsEqual(pole.id, this.editingPoleId)) {
      this.poleEditState = 'idle';
      this.editingPoleId = null;
    }

    this.selectedPoleId = pole.id;

    if (pole.position) {
      const targetPoint = new THREE.Vector3(
        pole.position.x,
        pole.position.y,
        pole.position.z ?? 0
      );
      this.frustumCulledService.teleportToPoint(targetPoint, this.getPoleCameraOffset());
      this.frustumCulledService.highlightPoleMarker(pole.id);

      if (
        pole.positionSource === 'geographic-bounds' &&
        !this.poleApproximationNoticeShown
      ) {
        this.snackBar.open(
          'Using project bounds to approximate pole position. Verify alignment visually.',
          'Dismiss',
          { duration: 5000 }
        );
        this.poleApproximationNoticeShown = true;
      }
    } else {
      this.frustumCulledService.highlightPoleMarker(null);
      this.snackBar.open('Pole is missing projected coordinates for this point cloud.', 'Dismiss', {
        duration: 4000
      });
    }
  }

  isPoleSelected(pole: PointCloudPole): boolean {
    return this.selectedPoleId === pole.id;
  }

  trackPoleById(index: number, pole: PointCloudPole): number | string {
    return pole.id ?? index;
  }

  startPoleAdjustment(pole: PointCloudPole, event?: Event): void {
    event?.stopPropagation();
    if (!pole) {
      return;
    }

    if (!this.currentPointCloud || typeof this.currentPointCloud.id !== 'number') {
      this.snackBar.open('Load a point cloud before adjusting poles.', 'Dismiss', { duration: 3000 });
      return;
    }

    this.selectedPoleId = pole.id;
    this.editingPoleId = pole.id ?? null;
    this.poleEditState = 'awaiting-point';
    this.frustumCulledService.setPoleEditingMode(true);
    this.snackBar.open('Click the point cloud to place the pole.', 'Dismiss', { duration: 4000 });
  }

  cancelPoleAdjustment(event?: Event): void {
    event?.stopPropagation();
    if (this.poleEditState === 'idle') {
      return;
    }
    this.poleEditState = 'idle';
    this.editingPoleId = null;
    this.frustumCulledService.setPoleEditingMode(false);
  }

  isPoleBeingEdited(pole: PointCloudPole): boolean {
    if (this.editingPoleId === null) {
      return false;
    }
    return this.poleIdsEqual(pole.id, this.editingPoleId);
  }

  private capturePoleAdjustment(clientX: number, clientY: number): void {
    if (this.poleEditState !== 'awaiting-point' || this.editingPoleId === null) {
      return;
    }

    const pickResult: PointPickResult | null = this.frustumCulledService.pickPointDetailed(clientX, clientY, {
      radiusPx: 4
    });
    if (!pickResult) {
      this.snackBar.open('No surface detected at that location. Try again.', 'Dismiss', { duration: 3000 });
      return;
    }

    this.applyPoleAdjustment(pickResult.position);
  }

  private applyPoleAdjustment(targetPoint: THREE.Vector3): void {
    if (!this.currentPointCloud || typeof this.currentPointCloud.id !== 'number') {
      this.snackBar.open('Point cloud unavailable. Reload and try again.', 'Dismiss', { duration: 3500 });
      this.poleEditState = 'idle';
      this.editingPoleId = null;
      this.frustumCulledService.setPoleEditingMode(false);
      return;
    }

    const poleId = this.editingPoleId;
    const existingPole = this.poles.find(pole => this.poleIdsEqual(pole.id, poleId));
    if (!existingPole) {
      this.snackBar.open('Pole is no longer loaded. Refresh the list and try again.', 'Dismiss', { duration: 3500 });
      this.poleEditState = 'idle';
      this.editingPoleId = null;
      this.frustumCulledService.setPoleEditingMode(false);
      return;
    }

    const payload: PointCloudPoleUpdateRequest = {
      position: {
        x: targetPoint.x,
        y: targetPoint.y,
        z: targetPoint.z
      }
    };

    this.poleEditState = 'saving';

    const identifier = existingPole.id ?? this.poles.indexOf(existingPole);
    this.api.updatePointCloudPole(this.currentPointCloud.id, identifier, payload)
      .pipe(take(1))
      .subscribe({
        next: updatedPole => {
          this.updatePoleInState(updatedPole);
          this.poleEditState = 'idle';
          this.editingPoleId = null;
          this.frustumCulledService.setPoleEditingMode(false);
          this.snackBar.open('Pole position updated.', 'Dismiss', { duration: 3000 });
          this.focusOnPole(updatedPole);
        },
        error: error => {
          console.error('Failed to update pole position:', error);
          this.snackBar.open('Failed to save pole position. Try again.', 'Dismiss', { duration: 4000 });
          this.poleEditState = 'awaiting-point';
        }
      });
  }

  private updatePoleInState(updatedPole: PointCloudPole): void {
    this.poles = this.poles.map(pole => {
      return this.poleIdsEqual(pole.id, updatedPole.id) ? { ...updatedPole } : pole;
    });
    this.updatePoleMarkers();
  }

  private poleIdsEqual(
    a: PointCloudPole['id'] | null | undefined,
    b: PointCloudPole['id'] | null | undefined
  ): boolean {
    return String(a ?? '') === String(b ?? '');
  }

  private tryFocusOnPendingPole(): void {
    if (this.pendingPoleFocusId === null || this.pendingPoleFocusId === undefined) {
      return;
    }

    if (!Array.isArray(this.poles) || this.poles.length === 0) {
      return;
    }

    const targetId = this.pendingPoleFocusId;
    const match = this.poles.find((pole, index) => {
      const key = pole.id ?? index;
      return String(key) === String(targetId);
    });
    if (!match) {
      return;
    }

    this.focusOnPole(match);
    this.pendingPoleFocusId = null;
  }

  private loadPolesForPointCloud(pointCloud: PointCloud): void {
    if (!pointCloud || typeof pointCloud.id !== 'number') {
      this.currentPointCloud = pointCloud ?? null;
      this.resetPoleState();
      return;
    }

    this.resetPoleState();
    this.polesLoading = true;

    this.api.getPointCloudPoles(pointCloud.id).pipe(
      take(1),
      takeUntil(this.destroy$)
    ).subscribe({
      next: response => {
        this.polesLoading = false;
        this.poleLoadError = null;
        this.poles = Array.isArray(response.poles) ? response.poles : [];
        this.selectedPoleId = null;
        this.updatePoleMarkers();
        this.tryFocusOnPendingPole();
        if (this.poles.length > 0) {
          this.polePanelOpen = true;
        }
      },
      error: error => {
        console.error('Failed to load poles for point cloud:', error);
        this.polesLoading = false;
        this.poleLoadError = 'Failed to load poles';
        this.frustumCulledService.clearPoleMarkers();
      }
    });
  }

  private updatePoleMarkers(): void {
    const markers = this.poles
      .filter(pole => pole.position && typeof pole.position?.x === 'number' && typeof pole.position?.y === 'number')
      .map(pole => ({
        id: pole.id,
        name: pole.name ?? null,
        x: pole.position!.x,
        y: pole.position!.y,
        z: this.resolvePoleHeight(pole)
      }));

    if (markers.length > 0) {
      this.frustumCulledService.setPoleMarkers(markers);
    } else {
      this.frustumCulledService.clearPoleMarkers();
    }
  }

  private refreshPoleMarkersAfterPointCloudLoad(): void {
    if (!Array.isArray(this.poles) || this.poles.length === 0) {
      return;
    }

    this.updatePoleMarkers();

    if (this.selectedPoleId !== null) {
      const activePole = this.poles.find(pole => this.poleIdsEqual(pole.id, this.selectedPoleId));
      if (activePole) {
        this.focusOnPole(activePole);
      }
    }
  }

  private resolvePoleHeight(pole: PointCloudPole): number {
    if (!pole.position) {
      return this.getPoleFallbackAltitude() ?? 0;
    }

    const fallbackZ = typeof pole.position.z === 'number' && Number.isFinite(pole.position.z)
      ? pole.position.z
      : null;
    const datasetFallbackZ = this.getPoleFallbackAltitude();
    const sourceLabel = (pole.positionSource ?? '').toString().toLowerCase();
    const overrideSource = (pole.positionOverride?.source ?? '').toString().toLowerCase();
    const hasExplicitZ = typeof fallbackZ === 'number' && Number.isFinite(fallbackZ);
    const shouldTrustFallback = (sourceLabel === 'manual' || overrideSource === 'manual') && hasExplicitZ;
    const samplingFallback = shouldTrustFallback
      ? (fallbackZ ?? datasetFallbackZ ?? null)
      : (datasetFallbackZ ?? null);

    const snappedZ = this.frustumCulledService.getGroundSnappedHeight(
      pole.position.x,
      pole.position.y,
      samplingFallback,
      {
        maxDeviation: shouldTrustFallback ? this.poleGroundSnapTolerance : Number.POSITIVE_INFINITY
      }
    );

    const finalZ = typeof snappedZ === 'number' && Number.isFinite(snappedZ)
      ? snappedZ
      : ((fallbackZ ?? datasetFallbackZ) ?? 0);

    pole.position.z = finalZ;
    return finalZ;
  }

  private getPoleFallbackAltitude(): number | null {
    const bounds = this.currentPointCloud?.bounds;
    if (!bounds?.min || !bounds?.max) {
      return null;
    }

    const minZ = typeof bounds.min.z === 'number' && Number.isFinite(bounds.min.z) ? bounds.min.z : null;
    const maxZ = typeof bounds.max.z === 'number' && Number.isFinite(bounds.max.z) ? bounds.max.z : null;

    if (minZ !== null && maxZ !== null) {
      return (minZ + maxZ) / 2;
    }

    return minZ ?? maxZ ?? null;
  }

  onPoleMarkerScaleChange(scale: number): void {
    if (Number.isNaN(scale)) {
      return;
    }
    this.poleMarkerScale = Math.min(Math.max(scale, this.poleMarkerScaleMin), this.poleMarkerScaleMax);
    this.frustumCulledService.setPoleMarkerScale(this.poleMarkerScale);
  }

  onPoleLabelToggle(visible: boolean): void {
    this.showPoleLabels = visible;
    this.frustumCulledService.setPoleLabelsVisible(visible);
  }

  private resetPoleState(): void {
    this.poles = [];
    this.selectedPoleId = null;
    this.poleLoadError = null;
    this.polesLoading = false;
    this.poleApproximationNoticeShown = false;
    this.poleEditState = 'idle';
    this.editingPoleId = null;
    this.frustumCulledService.setPoleEditingMode(false);
    this.frustumCulledService.clearPoleMarkers();
  }

  private getPoleCameraOffset(): number {
    const bounds = this.currentPointCloud?.bounds;
    if (!bounds || !bounds.min || !bounds.max) {
      return this.defaultPoleCameraOffset;
    }

    const minX = bounds.min.x;
    const minY = bounds.min.y;
    const maxX = bounds.max.x;
    const maxY = bounds.max.y;

    if (
      typeof minX !== 'number' || typeof minY !== 'number' ||
      typeof maxX !== 'number' || typeof maxY !== 'number'
    ) {
      return this.defaultPoleCameraOffset;
    }

    const sizeX = Math.abs(maxX - minX);
    const sizeY = Math.abs(maxY - minY);
    const dominantSize = Math.max(sizeX, sizeY);

    if (!Number.isFinite(dominantSize) || dominantSize <= 0) {
      return this.defaultPoleCameraOffset;
    }

    const scaled = dominantSize * 0.08;
    return Math.min(Math.max(scaled, 25), 250);
  }

  // Display controls
  setColorMode(mode: 'rgb' | 'elevation' | 'classification' | 'intensity' | 'cluster'): void {
    console.log(`🎨 Switching to ${mode} color mode`);
    this.currentColorMode = mode;

    // Map intensity to a supported mode until backend implementation is ready
    const serviceMode: 'rgb' | 'elevation' | 'classification' | 'cluster' =
      mode === 'intensity' ? 'rgb' : mode;

    this.frustumCulledService.setColorScheme(serviceMode);
    if (mode === 'classification') {
      this.syncClassificationColorsToService();
    }

    if (mode !== 'classification') {
      this.cancelPendingClassification(false);
      if (this.currentTool === 'lasso') {
        this.currentTool = null;
      }
    }

    // TODO: Implement intensity mode in FrustumCulledCOPCService
    if (mode === 'intensity') {
      console.warn('Intensity mode not yet implemented in backend - displaying RGB');
    }
  }

  increasePointSize(): void {
    this.pointSize = Math.min(10, this.pointSize + 1);
    this.frustumCulledService.setPointSize(this.pointSize);
  }

  decreasePointSize(): void {
    this.pointSize = Math.max(1, this.pointSize - 1);
    this.frustumCulledService.setPointSize(this.pointSize);
  }

  zoomIn(): void {
    // Zoom in by moving camera closer or adjusting FOV
    this.frustumCulledService.zoomIn();
  }

  zoomOut(): void {
    // Zoom out by moving camera farther or adjusting FOV
    this.frustumCulledService.zoomOut();
  }

  resetView(): void {
    this.frustumCulledService.resetView();
  }

  toggleFullscreen(): void {
    if (!document.fullscreenElement) {
      this.renderArea.nativeElement.requestFullscreen();
      this.isFullscreen = true;
    } else {
      document.exitFullscreen();
      this.isFullscreen = false;
    }
  }

  // Export functions
  exportImage(): void {
    this.frustumCulledService.exportImage();
  }

  setTool(tool: 'lasso' | 'measure' | 'pan' | 'point-info' | null): void {
    if (tool === 'lasso' && this.currentColorMode !== 'classification') {
      this.snackBar.open('Lasso classification is only available in Classification mode', 'OK', { duration: 3000 });
      return;
    }

    if (this.currentTool === tool) {
      this.currentTool = null;
      if (tool === 'lasso') {
        this.cancelPendingClassification(false);
      }
      if (tool === 'measure') {
        this.frustumCulledService.hideMeasurementPreview();
      }
      return;
    }

    this.currentTool = tool;

    if (tool === 'measure') {
      this.measurementPoints = [];
      this.measurementScreenPoints = [];
      this.measurementDistance = 0;
      this.previewDistance = 0;
      this.frustumCulledService.hideMeasurementPreview();
      this.cancelPendingClassification(false);
    }

    if (tool === 'lasso') {
      this.updateViewportDimensions();
      this.lassoPoints = [];
      this.isLassoActive = false;
    }

    if (tool === 'pan') {
      // Pan tool selected - camera controls will handle pan mode
      this.cancelPendingClassification(false);
    }

    if (tool === 'point-info') {
      // Point info tool selected - click on points to inspect
      this.cancelPendingClassification(false);
      this.snackBar.open('Click on a point to inspect its properties', 'OK', { duration: 2000 });
    }

    console.log(`Tool set to: ${this.currentTool || 'none'}`);
  }

  @HostListener('mousedown', ['$event'])
  onMouseDown(event: MouseEvent): void {
    if (this.currentTool === 'lasso') {
      if (event.button !== 0 || !this.isEventInsideRenderArea(event)) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      this.startLassoSelection(event.clientX, event.clientY);
    } else if (this.currentTool === 'measure') {
      // Only add measurement point on left-click (button 0)
      if (event.button !== 0 || !this.isEventInsideRenderArea(event)) {
        return;
      }
      this.addMeasurementPoint(event.clientX, event.clientY);
    } else if (this.currentTool === 'point-info') {
      if (event.button !== 0 || !this.isEventInsideRenderArea(event)) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      this.inspectPointAt(event.clientX, event.clientY);
    }
  }

  @HostListener('mousemove', ['$event'])
  onMouseMove(event: MouseEvent): void {
    if (this.poleEditState === 'saving') {
      return;
    }

    const insideRender = this.isEventInsideRenderArea(event);
    if (!insideRender && !this.isLassoActive && !(this.currentTool === 'measure' && this.measurementPoints.length === 1)) {
      return;
    }

    // Update current mouse position
    const pointer = this.getPointerPosition(event.clientX, event.clientY);
    this.currentMousePos = pointer;

    // Update measurement preview
    if (this.currentTool === 'measure' && this.measurementPoints.length === 1) {
      this.updateMeasurementPreview(event.clientX, event.clientY);
    }

    // Update lasso selection
    if (this.currentTool === 'lasso' && this.isLassoActive) {
      event.preventDefault();
      event.stopPropagation();
      this.updateLassoSelection(event.clientX, event.clientY);
    }
  }

  @HostListener('mouseup', ['$event'])
  onMouseUp(event: MouseEvent): void {
    if (this.currentTool === 'lasso' && this.isLassoActive) {
      if (event.button !== 0) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      this.completeLassoSelection();
    }
  }

  @HostListener('dblclick', ['$event'])
  onDoubleClick(event: MouseEvent): void {
    if (this.poleEditState === 'awaiting-point' || this.poleEditState === 'saving') {
      event.preventDefault();
      return;
    }

    // Lasso tool completion takes priority
    if (this.currentTool === 'lasso' && this.lassoPoints.length > 0 && this.isEventInsideRenderArea(event)) {
      event.preventDefault();
      this.completeLassoSelection();
      return;
    }

    // Teleport to point if no tool is active
    if (!this.currentTool && this.isEventInsideRenderArea(event)) {
      event.preventDefault();
      this.teleportToPoint(event.clientX, event.clientY);
    }
  }

  @HostListener('click', ['$event'])
  onHostClick(event: MouseEvent): void {
    if (this.poleEditState !== 'awaiting-point') {
      return;
    }
    if (event.button !== 0 || !this.isEventInsideRenderArea(event)) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    this.capturePoleAdjustment(event.clientX, event.clientY);
  }

  @HostListener('document:keydown.escape')
  onEscapeKey(): void {
    if (this.poleEditState !== 'idle') {
      this.cancelPoleAdjustment();
    }
  }

  // Teleport to point on double-click
  private teleportToPoint(x: number, y: number): void {
    const point = this.frustumCulledService.getTeleportPoint(x, y);

    if (point) {
      this.frustumCulledService.teleportToPoint(point, 50); // 50m offset
      this.snackBar.open(`📍 Teleported to (${point.x.toFixed(1)}, ${point.y.toFixed(1)}, ${point.z.toFixed(1)})`, 'OK', {
        duration: 2000
      });
    } else {
      this.snackBar.open('No point found at this location', 'OK', { duration: 1500 });
    }
  }

  selectClassification(classification: Classification): void {
    if (this.pendingClassification) {
      this.cancelPendingClassification(false);
    }
    this.selectedClassification = classification;
    console.log(`Selected classification: ${classification.name} (ID: ${classification.value})`);
  }

  selectSourceClassification(classification: Classification): void {
    if (this.pendingClassification) {
      this.cancelPendingClassification(false);
    }
    this.selectedSourceClassification = classification;
    console.log(`Source classification set to: ${classification.name} (ID: ${classification.value})`);
  }

  addCustomClassification(): void {
    console.log('Add custom classification (placeholder)');
  }

  editClassification(classification: Classification): void {
    console.log('Edit classification (placeholder)');
  }

  deleteClassification(classification: Classification): void {
    console.log('Delete classification (placeholder)');
  }

  formatPointCount(count?: number): string {
    if (!count) return '0';
    if (count >= 1000000) {
      return (count / 1000000).toFixed(1) + 'M';
    } else if (count >= 1000) {
      return (count / 1000).toFixed(1) + 'K';
    }
    return count.toString();
  }

  updateClassificationColor(classification: Classification, color: string): void {
    const normalized = this.normalizeHexColor(color);
    if (!normalized) {
      this.snackBar.open('Please use a hex color like #3B82F6', 'OK', { duration: 2500 });
      return;
    }

    const values = this.getClassificationValues(classification);
    const nextOverrides = { ...this.classificationColorOverrides };
    const defaultColor = this.normalizeHexColor(classification.defaultColor ?? classification.color);

    values.forEach(value => {
      if (defaultColor && normalized === defaultColor) {
        delete nextOverrides[value];
      } else {
        nextOverrides[value] = normalized;
      }
    });

    this.classificationColorOverrides = nextOverrides;
    this.pushRecentClassificationColor(normalized);
    this.applyClassificationOverridesToClassifications();
    this.syncClassificationColorsToService();
    this.frustumCulledService.refreshClassificationColorLUT();
    this.saveDisplayPreferences();

    // Persist to backend (global color scheme)
    this.classificationColorService.updateColor(classification.value, normalized).subscribe({
      next: () => {
        console.log(`✅ Persisted color change for classification ${classification.value} to backend`);
        this.snackBar.open(`Updated ${classification.name} color globally`, 'OK', { duration: 2000 });
        this.recolorActivePointCloud();
      },
      error: (err) => {
        console.error('Failed to persist color change to backend:', err);
        this.snackBar.open('Failed to save color change', 'OK', { duration: 3000 });
      }
    });
  }

  startEditingClassificationColor(classification: Classification): void {
    this.colorEditingClassification = classification;
    this.classificationColorDraft = this.resolveClassificationColor(classification);
  }

  closeColorEditor(): void {
    this.colorEditingClassification = null;
  }

  onClassificationDraftInput(value: string): void {
    const normalized = this.normalizeHexColor(value) ?? value;
    this.classificationColorDraft = normalized;
  }

  applyClassificationDraft(): void {
    if (!this.colorEditingClassification) {
      return;
    }

    const normalized = this.normalizeHexColor(this.classificationColorDraft);
    if (!normalized) {
      this.snackBar.open('Please use a hex color like #3B82F6', 'OK', { duration: 2500 });
      return;
    }

    this.updateClassificationColor(this.colorEditingClassification, normalized);
    this.pushRecentClassificationColor(normalized);
    this.classificationColorDraft = normalized;
  }

  applyRecentClassificationColor(color: string): void {
    this.classificationColorDraft = color;
    this.applyClassificationDraft();
  }

  resetAllClassificationColors(): void {
    if (Object.keys(this.classificationColorOverrides).length === 0) {
      return;
    }
    this.classificationColorOverrides = {};
    this.applyClassificationOverridesToClassifications();
    this.syncClassificationColorsToService();
    this.frustumCulledService.refreshClassificationColorLUT();
    this.saveDisplayPreferences();
    if (this.colorEditingClassification) {
      this.classificationColorDraft = this.resolveClassificationColor(this.colorEditingClassification);
    }
  }

  private pushRecentClassificationColor(color: string): void {
    const normalized = this.normalizeHexColor(color);
    if (!normalized) {
      return;
    }
    const updated = [normalized, ...this.recentClassificationColors.filter(c => c !== normalized)].slice(0, 6);
    this.recentClassificationColors = updated;
    this.saveClassificationColorHistory();
  }

  resetClassificationColor(classification: Classification): void {
    const values = this.getClassificationValues(classification);
    const nextOverrides = { ...this.classificationColorOverrides };
    let changed = false;

    values.forEach(value => {
      if (nextOverrides[value]) {
        delete nextOverrides[value];
        changed = true;
      }
    });

    // Always snap the UI back to the default palette even if no overrides existed
    if (!changed && this.hasCustomClassificationColor(classification)) {
      changed = true;
    }

    if (!changed) {
      return;
    }

    this.classificationColorOverrides = nextOverrides;
    this.applyClassificationOverridesToClassifications();
    this.syncClassificationColorsToService();
    this.saveDisplayPreferences();

    // Reset to default color in backend
    const defaultColor = classification.defaultColor ?? classification.color;
    this.classificationColorService.updateColor(classification.value, defaultColor).subscribe({
      next: () => {
        console.log(`✅ Reset classification ${classification.value} to default color in backend`);
        this.snackBar.open(`Reset ${classification.name} to default color`, 'OK', { duration: 2000 });
        this.frustumCulledService.refreshClassificationColorLUT();
        this.recolorActivePointCloud();
      },
      error: (err) => {
        console.error('Failed to reset color in backend:', err);
      }
    });
  }

  hasCustomClassificationColor(classification: Classification): boolean {
    const resolved = this.resolveClassificationColor(classification);
    const defaultColor = this.normalizeHexColor(classification.defaultColor ?? classification.color);
    return resolved !== (defaultColor ?? resolved);
  }

  private normalizeHexColor(color: string | null | undefined): string | null {
    if (!color) {
      return null;
    }

    const trimmed = color.trim();
    const prefixed = trimmed.startsWith('#') ? trimmed : `#${trimmed}`;
    if (!/^#([0-9a-fA-F]{6})$/.test(prefixed)) {
      return null;
    }
    return prefixed.toUpperCase();
  }

  retry(): void {
    this.selectedPointCloud$.pipe(take(1)).subscribe(pc => {
      if (pc) {
        this.loadPointCloudInViewer(pc);
      }
    });
  }

  toggleDetailsPanel(): void {
    this.detailsPanelOpen = !this.detailsPanelOpen;
  }

  private startStatsUpdate(): void {
    // Update stats every frame for smooth camera tracking
    const updateStats = () => {
      const metrics = this.frustumCulledService.getMetrics();
      // Estimate rendered points (this is approximate)
      this.renderedPoints = metrics.chunksVisible * 50000; // Rough estimate

      // Update camera position and orientation
      const camera = this.frustumCulledService.getCamera();
      if (camera) {
        this.cameraX = camera.position.x;
        this.cameraY = camera.position.y;
        this.cameraZ = camera.position.z;

        // Calculate azimuth (horizontal rotation) from camera direction
        const direction = new THREE.Vector3();
        camera.getWorldDirection(direction);

        // Azimuth: angle from north (Y axis) in XY plane
        this.cameraAzimuth = Math.atan2(direction.x, direction.y) * (180 / Math.PI);
        if (this.cameraAzimuth < 0) this.cameraAzimuth += 360;

        // Pitch: angle from horizontal
        this.cameraPitch = Math.asin(direction.z) * (180 / Math.PI);
      }

      this.frustumCulledService.processClassificationOverrides();
      requestAnimationFrame(updateStats);
    };
    updateStats();
  }

  formatFileSize(bytes: number): string {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return Math.round((bytes / Math.pow(k, i)) * 100) / 100 + ' ' + sizes[i];
  }

  formatArea(km2?: number): string {
    if (!km2) return '0 km²';
    return km2.toFixed(2) + ' km²';
  }

  private addMeasurementPoint(x: number, y: number): void {
    const pickResult: PointPickResult | null = this.frustumCulledService.pickPointDetailed(x, y, { radiusPx: 8 });
    if (!pickResult) {
      this.snackBar.open('No point found - click directly on the point cloud.', 'OK', { duration: 2000 });
      return;
    }

    const point = pickResult.position;
    this.measurementPoints.push(point);
    this.measurementScreenPoints.push({ x, y });

    if (this.measurementPoints.length === 2) {
      const [p1, p2] = this.measurementPoints;
      this.measurementDistance = p1.distanceTo(p2);
      this.frustumCulledService.hideMeasurementPreview();

      if (this.activePointCloudId) {
        this.saveMeasurementToBackend(p1, p2, this.measurementDistance);
      }

      this.measurementPoints = [];
      this.measurementScreenPoints = [];
      this.previewDistance = 0;
      this.measurementDistance = 0;
      this.measurementsPanelOpen = true;
    } else {
      this.frustumCulledService.showMeasurementPreview(point);
      this.snackBar.open('Click a second point to complete the measurement.', 'OK', { duration: 2000 });
    }
  }

  private updateMeasurementPreview(x: number, y: number): void {
    if (this.measurementPoints.length !== 1) {
      return;
    }

    const pickResult: PointPickResult | null = this.frustumCulledService.pickPointDetailed(x, y, { radiusPx: 8 });
    if (pickResult) {
      const previewPoint = pickResult.position;
      this.previewDistance = this.measurementPoints[0].distanceTo(previewPoint);
      this.frustumCulledService.updateMeasurementPreview(this.measurementPoints[0], previewPoint);
    }
  }

  async deleteMeasurement(id: number): Promise<void> {
    if (!this.activePointCloudId) return;

    try {
      // Delete from backend
      await this.measurementService.deleteMeasurementAsync(this.activePointCloudId, id);

      // Remove from 3D scene
      this.frustumCulledService.removeMeasurementLine(id);

      // Remove from saved measurements
      this.savedMeasurements = this.savedMeasurements.filter(m => m.id !== id);

      // Update menu state
      this.menuService.updateMenuState({
        hasMeasurements: this.savedMeasurements.length > 0
      });

      this.snackBar.open('Measurement deleted', 'OK', { duration: 2000 });
    } catch (error) {
      console.error('Failed to delete measurement:', error);
      this.snackBar.open('Failed to delete measurement', 'OK', { duration: 3000 });
    }
  }

  async clearAllMeasurements(): Promise<void> {
    if (!this.activePointCloudId) return;

    try {
      // Delete all from backend
      await this.measurementService.deleteAllMeasurementsAsync(this.activePointCloudId);

      // Clear all 3D visualizations
      this.frustumCulledService.clearMeasurements();

      // Clear all data
      this.savedMeasurements = [];
      this.measurementPoints = [];
      this.measurementScreenPoints = [];
      this.measurementDistance = 0;
      this.previewDistance = 0;

      // Update menu state
      this.menuService.updateMenuState({
        hasMeasurements: false
      });

      this.snackBar.open('All measurements cleared', 'OK', { duration: 2000 });
    } catch (error) {
      console.error('Failed to clear measurements:', error);
      this.snackBar.open('Failed to clear measurements', 'OK', { duration: 3000 });
    }
  }

  private inspectPointAt(clientX: number, clientY: number): void {
    const pickResult: PointPickResult | null = this.frustumCulledService.pickPointDetailed(clientX, clientY, { radiusPx: 4 });
    if (!pickResult) {
      this.pointInfoResult = null;
      this.pointInfoError = 'No point detected. Zoom in and click directly on the point cloud.';
      this.snackBar.open('No point detected at that location.', 'Dismiss', { duration: 2500 });
      return;
    }

    const latLng = this.projectWorldToLatLng(pickResult.position);
    this.pointInfoResult = {
      position: {
        x: pickResult.position.x,
        y: pickResult.position.y,
        z: pickResult.position.z,
      },
      classification: pickResult.classification ?? null,
      color: pickResult.color ?? null,
      lat: latLng?.lat ?? null,
      lng: latLng?.lng ?? null,
      pointIndex: pickResult.pointIndex ?? null,
      intensity: pickResult.intensity ?? null,
      returnNumber: pickResult.returnNumber ?? null,
      timestamp: new Date(),
    };
    this.pointInfoError = null;
  }

  clearPointInfo(): void {
    this.pointInfoResult = null;
    this.pointInfoError = null;
  }

  copyPointInfo(): void {
    if (!this.pointInfoResult || typeof navigator?.clipboard?.writeText !== 'function') {
      return;
    }

    const { position, lat, lng, classification } = this.pointInfoResult;
    const segments = [
      `X=${position.x.toFixed(3)}`,
      `Y=${position.y.toFixed(3)}`,
      `Z=${position.z.toFixed(3)}`,
    ];
    if (typeof classification === 'number') {
      segments.push(`Class=${classification}`);
    }
    if (typeof lat === 'number' && typeof lng === 'number') {
      segments.push(`Lat=${lat.toFixed(6)}`, `Lng=${lng.toFixed(6)}`);
    }

    navigator.clipboard
      .writeText(segments.join(', '))
      .then(() => this.snackBar.open('Point coordinates copied.', 'Dismiss', { duration: 1500 }))
      .catch(() => this.snackBar.open('Unable to copy coordinates.', 'Dismiss', { duration: 2000 }));
  }

  private projectWorldToLatLng(point: THREE.Vector3): { lat: number; lng: number } | null {
    const bounds = this.currentPointCloud?.bounds;
    const geographic = bounds?.geographic;
    if (
      !bounds?.min ||
      !bounds?.max ||
      !geographic?.southWest ||
      !geographic?.northEast
    ) {
      return null;
    }

    const minX = bounds.min.x;
    const maxX = bounds.max.x;
    const minY = bounds.min.y;
    const maxY = bounds.max.y;

    if (
      typeof minX !== 'number' ||
      typeof maxX !== 'number' ||
      typeof minY !== 'number' ||
      typeof maxY !== 'number'
    ) {
      return null;
    }

    const spanX = maxX - minX;
    const spanY = maxY - minY;
    if (!Number.isFinite(spanX) || spanX === 0 || !Number.isFinite(spanY) || spanY === 0) {
      return null;
    }

    const ratioX = (point.x - minX) / spanX;
    const ratioY = (point.y - minY) / spanY;

    const latSpan = geographic.northEast.lat - geographic.southWest.lat;
    const lngSpan = geographic.northEast.lng - geographic.southWest.lng;
    if (!Number.isFinite(latSpan) || !Number.isFinite(lngSpan)) {
      return null;
    }

    const lat = geographic.southWest.lat + ratioY * latSpan;
    const lng = geographic.southWest.lng + ratioX * lngSpan;

    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      return null;
    }

    return { lat, lng };
  }

  toggleMeasurementsPanel(): void {
    this.measurementsPanelOpen = !this.measurementsPanelOpen;
    if (this.measurementsPanelOpen) {
      this.statisticsPanelOpen = false;
      this.settingsPanelOpen = false;
      this.polePanelOpen = false;
    }
  }

  toggleClusterPanel(): void {
    this.clusterPanelOpen = !this.clusterPanelOpen;
    if (this.clusterPanelOpen) {
      if (this.trainedModels.length === 0) {
        this.loadTrainedModels();
      }
      this.loadClusterJobsForCurrentPointCloud();
    }
  }

  private loadClusterJobsForCurrentPointCloud(): void {
    if (!this.currentPointCloud || !this.currentPointCloud.id) {
      this.activeGenerationJobs = [];
      this.overlayManifestItems = [];
      return;
    }

    // Load generation jobs for this point cloud
    this.clusterAnalysis
      .listClusterGenerationJobs(this.currentPointCloud.id)
      .pipe(take(1))
      .subscribe({
        next: jobs => {
          this.activeGenerationJobs = jobs.map(job => ({
            ...job,
            previousStatus: job.status,
          }));

          // If there are completed jobs, load their overlays
          const completedJobs = this.activeGenerationJobs.filter(
            j => j.status === 'completed' && j.clusterJobName && j.runName
          );
          if (completedJobs.length > 0) {
            this.loadOverlaysForCompletedJobs(completedJobs);
          }
        },
        error: err => {
          console.error('Failed to load cluster jobs for point cloud', err);
        },
      });
  }

  private loadOverlaysForCompletedJobs(completedJobs: ClusterGenerationJobWithHistory[]): void {
    // Pick the most recent completed job by completion/update time
    const completedSorted = [...completedJobs].sort((a, b) => {
      const aDate = new Date(a.completedAt || a.updatedAt || a.receivedAt).getTime();
      const bDate = new Date(b.completedAt || b.updatedAt || b.receivedAt).getTime();
      return bDate - aDate;
    });
    const mostRecent = completedSorted[0];
    const { clusterJobName, runName } = mostRecent;
    if (!clusterJobName || !runName) {
      return;
    }

    this.clusterAnalysis
      .getClusterJobDetail(runName, clusterJobName)
      .pipe(take(1))
      .subscribe({
        next: detail => {
          if (detail.overlays && detail.overlays.length > 0) {
            const match = detail.overlays.find(
              item => item.pointcloudId === this.currentPointCloud?.id
            );
            if (match) {
              this.overlayManifestItems = [match];
              this.selectedClusterJob = {
                runName,
                jobName: clusterJobName,
                createdAt: detail.createdAt,
                clusters: detail.clusters,
                inertia: detail.inertia,
                iterations: detail.iterations,
                summaryPath: detail.embeddingsFile,
                hasOverlays: true,
              };
            }
          }
        },
        error: err => {
          console.error('Failed to load overlay details', err);
        },
      });
  }

  loadTrainedModels(): void {
    this.trainedModelsLoading = true;
    this.clusterAnalysis
      .listTrainedModels()
      .pipe(take(1))
      .subscribe({
        next: models => {
          this.trainedModels = models;
          this.trainedModelsLoading = false;
          if (models.length > 0 && !this.selectedModelCheckpoint) {
            // Auto-select the most recent model
            this.selectedModelCheckpoint = models[0].checkpointPath;
          }
        },
        error: err => {
          console.error('Failed to load trained models', err);
          this.trainedModelsLoading = false;
        },
      });
  }


  loadClusterOverlay(item: ClusterOverlayManifestItem): void {
    if (!this.selectedClusterJob) {
      return;
    }
    if (!this.currentPointCloud || item.pointcloudId !== this.currentPointCloud.id) {
      this.snackBar.open('Overlay does not match the active point cloud', 'Dismiss', { duration: 3000 });
      return;
    }
    this.overlayLoading = true;
    this.clusterAnalysis
      .getOverlayPayload(this.selectedClusterJob.runName, this.selectedClusterJob.jobName, item.overlayName)
      .pipe(take(1))
      .subscribe({
        next: payload => {
          this.overlayLoading = false;
          if (!this.currentPointCloud || payload.pointcloudId !== this.currentPointCloud.id) {
            this.snackBar.open('Overlay payload does not match the active point cloud', 'Dismiss', { duration: 3000 });
            return;
          }
          const palette = this.buildClusterPalette(payload.clusterCounts);
          this.clusterOverlayPalette = palette;
          this.clusterOverlayCounts = payload.clusterCounts ?? {};
          this.frustumCulledService.applyClusterClassificationOverlay(payload.overrides ?? {}, palette);
          this.clusterOverlayActive = true;
          this.activeOverlayFilePath = payload.filePath;
          this.snackBar.open('Cluster overlay applied', 'OK', { duration: 2000 });
        },
        error: err => {
          console.error('Failed to load overlay payload', err);
          this.overlayLoading = false;
          this.snackBar.open('Failed to load overlay', 'Dismiss', { duration: 4000 });
        },
      });
  }

  clearClusterOverlay(): void {
    this.resetClusterOverlayState();
    this.snackBar.open('Cluster overlay cleared', 'OK', { duration: 2000 });
  }

  private resetClusterOverlayState(): void {
    this.clusterOverlayActive = false;
    this.clusterOverlayCounts = {};
    this.activeOverlayFilePath = null;
    this.frustumCulledService.clearClusterClassificationOverlay();
  }

  getClusterStatusLabel(status: ClusterGenerationJob['status']): string {
    return this.clusterStatusLabels[status] ?? status;
  }

  getClusterStatusIcon(status: ClusterGenerationJob['status']): string {
    return this.clusterStatusIcons[status] ?? 'sync';
  }

  getClusterStageState(
    job: ClusterGenerationJobWithHistory,
    stageKey: ClusterJobStageKey
  ): 'done' | 'active' | 'upcoming' | 'failed' {
    const stageIndex = this.clusterStageOrder.indexOf(stageKey);
    if (stageIndex === -1) {
      return 'upcoming';
    }

    let normalizedStatus: ClusterJobStageKey | null = null;
    if (job.status === 'failed' || job.status === 'cancelled') {
      if (job.previousStatus && this.clusterStageOrder.includes(job.previousStatus as ClusterJobStageKey)) {
        normalizedStatus = job.previousStatus as ClusterJobStageKey;
      } else {
        normalizedStatus = 'queued';
      }
    } else if (job.status === 'completed') {
      normalizedStatus = 'building_overlay';
    } else {
      normalizedStatus = job.status as ClusterJobStageKey;
    }

    const currentIndex = normalizedStatus ? this.clusterStageOrder.indexOf(normalizedStatus) : -1;
    if (currentIndex === -1) {
      return 'upcoming';
    }

    if ((job.status === 'failed' || job.status === 'cancelled') && stageIndex === currentIndex) {
      return 'failed';
    }

    if (stageIndex < currentIndex) {
      return 'done';
    }

    if (stageIndex === currentIndex) {
      return 'active';
    }

    return 'upcoming';
  }

  getJobStepPercentage(job: ClusterGenerationJob): number {
    if (!job.totalSteps || job.totalSteps <= 0) {
      return 0;
    }

    const percent = (job.currentStep / job.totalSteps) * 100;
    if (!Number.isFinite(percent)) {
      return 0;
    }

    return Math.max(0, Math.min(100, Math.round(percent)));
  }

  getStageProgressValue(job: ClusterGenerationJob, stageKey: ClusterJobStageKey): number {
    const state = this.getClusterStageState(job, stageKey);
    if (state === 'done') {
      return 100;
    }
    if (state === 'active') {
      const percent = this.getJobStepPercentage(job);
      return percent > 0 ? percent : 5;
    }
    return 0;
  }

  isJobActionInFlight(jobId: string): boolean {
    return Boolean(this.jobActionLoading[jobId]);
  }

  private setJobActionLoading(jobId: string, loading: boolean): void {
    if (loading) {
      this.jobActionLoading = { ...this.jobActionLoading, [jobId]: true };
    } else {
      const { [jobId]: _removed, ...rest } = this.jobActionLoading;
      this.jobActionLoading = rest;
    }
  }

  trackClusterRun(_: number, job: ClusterGenerationJobWithHistory): string {
    return job.id;
  }

  get selectedCoverageDescription(): string {
    const option = this.coverageOptions.find(o => o.value === this.clusterGenerationConfig.targetCoverage);
    return option?.description || 'Choose speed vs quality tradeoff';
  }

  generateClusters(): void {
    if (!this.currentPointCloud || !this.currentPointCloud.id) {
      this.snackBar.open('No point cloud loaded', 'Dismiss', { duration: 3000 });
      return;
    }

    if (this.clusterModelMode === 'existing' && !this.selectedModelCheckpoint) {
      this.snackBar.open('Please select a trained model', 'Dismiss', { duration: 3000 });
      return;
    }

    this.clusterGenerationInProgress = true;

    const request = {
      ...this.clusterGenerationConfig,
      checkpointPath: this.clusterModelMode === 'existing' ? this.selectedModelCheckpoint : null,
    };

    this.clusterAnalysis
      .generateClusters(this.currentPointCloud.id, request)
      .pipe(take(1))
      .subscribe({
        next: job => {
          this.clusterGenerationInProgress = false;
          const normalizedJob: ClusterGenerationJobWithHistory = {
            ...job,
            previousStatus: job.status,
          };
          this.activeGenerationJobs.unshift(normalizedJob);
          const message = this.clusterModelMode === 'existing'
            ? 'Running inference with existing model...'
            : 'Training new model and generating clusters...';
          this.snackBar.open(message, 'OK', { duration: 3000 });
          this.startGenerationJobPolling();
        },
        error: err => {
          this.clusterGenerationInProgress = false;
          console.error('Failed to start cluster generation', err);
          this.snackBar.open('Failed to start cluster generation', 'Dismiss', { duration: 4000 });
        },
      });
  }

  canCancelJob(job: ClusterGenerationJob): boolean {
    return !['completed', 'failed', 'cancelled'].includes(job.status);
  }

  cancelClusterJob(job: ClusterGenerationJob): void {
    if (!this.canCancelJob(job) || this.isJobActionInFlight(job.id)) {
      return;
    }
    this.setJobActionLoading(job.id, true);
    this.clusterAnalysis
      .cancelClusterGenerationJob(job.id)
      .pipe(take(1))
      .subscribe({
        next: updated => {
          const index = this.activeGenerationJobs.findIndex(j => j.id === job.id);
          if (index !== -1) {
            this.activeGenerationJobs[index] = {
              ...this.activeGenerationJobs[index],
              ...updated,
              previousStatus: this.activeGenerationJobs[index].status,
            };
          }
          this.snackBar.open('Cluster run cancelled.', 'Dismiss', { duration: 3000 });
        },
        error: err => {
          console.error('Failed to cancel cluster generation job', err);
          this.snackBar.open('Failed to cancel cluster run', 'Dismiss', { duration: 4000 });
        },
        complete: () => {
          this.setJobActionLoading(job.id, false);
          this.startGenerationJobPolling();
        },
      });
  }

  canDeleteJob(job: ClusterGenerationJob): boolean {
    return ['completed', 'failed', 'cancelled'].includes(job.status);
  }

  deleteClusterJob(job: ClusterGenerationJob): void {
    if (!this.canDeleteJob(job) || this.isJobActionInFlight(job.id)) {
      return;
    }
    this.setJobActionLoading(job.id, true);
    this.clusterAnalysis
      .deleteClusterGenerationJob(job.id)
      .pipe(take(1))
      .subscribe({
        next: () => {
          this.activeGenerationJobs = this.activeGenerationJobs.filter(j => j.id !== job.id);
          this.snackBar.open('Cluster run deleted.', 'Dismiss', { duration: 3000 });
        },
        error: err => {
          console.error('Failed to delete cluster generation job', err);
          this.snackBar.open('Failed to delete cluster run', 'Dismiss', { duration: 4000 });
        },
        complete: () => {
          this.setJobActionLoading(job.id, false);
        },
      });
  }

  private startGenerationJobPolling(): void {
    if (this.generationJobPollHandle !== null) {
      return;
    }

    const poll = () => {
      if (this.activeGenerationJobs.length === 0) {
        this.stopGenerationJobPolling();
        return;
      }

      // Poll only active jobs (not completed or failed)
      const activeJobs = this.activeGenerationJobs.filter(
        job => job.status !== 'completed' && job.status !== 'failed' && job.status !== 'cancelled'
      );

      // Stop polling if no active jobs
      if (activeJobs.length === 0) {
        console.log('No active cluster jobs, stopping poll');
        this.stopGenerationJobPolling();
        return;
      }

      // Poll each active job
      activeJobs.forEach(job => {
        const index = this.activeGenerationJobs.findIndex(j => j.id === job.id);
        if (index === -1) return;

        this.clusterAnalysis
          .getClusterGenerationJob(job.id)
          .pipe(take(1))
          .subscribe({
            next: updatedJob => {
              const previousStatus = this.activeGenerationJobs[index]?.status ?? updatedJob.status;
              this.activeGenerationJobs[index] = {
                ...this.activeGenerationJobs[index],
                ...updatedJob,
                previousStatus: ['failed', 'cancelled'].includes(updatedJob.status as string)
                  ? previousStatus
                  : updatedJob.status,
              };

              // If job completed, refresh cluster jobs list
              if (updatedJob.status === 'completed') {
                this.snackBar.open(
                  `Cluster generation completed! ${updatedJob.progressMessage || ''}`,
                  'OK',
                  { duration: 6000 }
                );
                this.refreshClusterJobsList();
                // Reload the point cloud to get updated COPC with cluster data
                if (this.currentPointCloud) {
                  window.location.reload();
                }
              } else if (updatedJob.status === 'failed') {
                this.snackBar.open('Cluster generation failed', 'Dismiss', { duration: 4000 });
              } else if (updatedJob.status === 'cancelled') {
                this.snackBar.open('Cluster generation cancelled', 'Dismiss', { duration: 4000 });
              }
            },
            error: err => {
              console.error('Failed to poll job status', err);
            },
          });
      });

      // Poll every 10 seconds (reduced from 5)
      this.generationJobPollHandle = window.setTimeout(poll, 10000);
    };

    // Start polling after 10 seconds
    this.generationJobPollHandle = window.setTimeout(poll, 10000);
  }

  private stopGenerationJobPolling(): void {
    if (this.generationJobPollHandle !== null) {
      window.clearTimeout(this.generationJobPollHandle);
      this.generationJobPollHandle = null;
    }
  }

  private refreshClusterJobsList(): void {
    this.loadClusterJobsForCurrentPointCloud();
  }

  private autoLoadCompletedClusterOverlay(completedJob: any): void {
    if (!completedJob.clusterJobName || !completedJob.runName) {
      return;
    }

    // Wait a moment for the overlay to be fully written
    setTimeout(() => {
      this.clusterAnalysis
        .getClusterJobDetail(completedJob.runName, completedJob.clusterJobName)
        .pipe(take(1))
        .subscribe({
          next: detail => {
            if (detail.overlays && detail.overlays.length > 0) {
              const match = detail.overlays.find(
                item => item.pointcloudId === this.currentPointCloud?.id
              );
              if (match) {
                this.selectedClusterJob = {
                  runName: completedJob.runName,
                  jobName: completedJob.clusterJobName,
                  createdAt: detail.createdAt,
                  clusters: detail.clusters,
                  inertia: detail.inertia,
                  iterations: detail.iterations,
                  summaryPath: detail.embeddingsFile,
                  hasOverlays: true,
                };
                this.overlayManifestItems = detail.overlays;
                this.loadClusterOverlay(match);
              }
            }
          },
          error: err => {
            console.error('Failed to auto-load completed overlay', err);
          },
        });
    }, 2000);
  }

  private buildClusterPalette(clusterCounts: Record<number, number> | null | undefined): Map<number, THREE.Color> {
    const palette = new Map<number, THREE.Color>();
    if (!clusterCounts) {
      return palette;
    }
    Object.keys(clusterCounts).forEach(clusterKey => {
      const clusterId = Number(clusterKey);
      if (!Number.isFinite(clusterId)) {
        return;
      }
      const hue = (clusterId * 53) % 360;
      const color = new THREE.Color().setHSL(hue / 360, 0.65, 0.55);
      palette.set(clusterId, color);
    });
    return palette;
  }

  exportMeasurements(): void {
    if (this.savedMeasurements.length === 0) {
      this.snackBar.open('No measurements to export', 'OK', { duration: 2000 });
      return;
    }

    // Create CSV content
    const headers = ['#', 'Distance (m)', 'Point 1 (X,Y,Z)', 'Point 2 (X,Y,Z)', 'Timestamp'];
    const rows = this.savedMeasurements.map((m, i) => {
      const p1 = m.points[0];
      const p2 = m.points[1];
      const timestamp = m.timestamp.toISOString();
      return [
        i + 1,
        m.distance.toFixed(2),
        `"${p1.x.toFixed(2)}, ${p1.y.toFixed(2)}, ${p1.z.toFixed(2)}"`,
        `"${p2.x.toFixed(2)}, ${p2.y.toFixed(2)}, ${p2.z.toFixed(2)}"`,
        timestamp
      ].join(',');
    });

    const csv = [headers.join(','), ...rows].join('\n');

    // Create download link
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = window.URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `measurements_${new Date().toISOString().split('T')[0]}.csv`;
    link.click();
    window.URL.revokeObjectURL(url);

    this.snackBar.open(`Exported ${this.savedMeasurements.length} measurements`, 'OK', { duration: 2000 });
  }

  toggleEDL(): void {
    this.edlEnabled = !this.edlEnabled;

    this.frustumCulledService.setEDLEnabled(this.edlEnabled);
    this.saveDisplayPreferences();

    const message = this.edlEnabled
      ? 'Eye-Dome Lighting enabled'
      : 'Eye-Dome Lighting disabled';

    this.snackBar.open(message, 'OK', { duration: 2000 });
    console.log(`EDL ${this.edlEnabled ? 'enabled' : 'disabled'}`);
  }

  toggleHull(): void {
    this.hullEnabled = !this.hullEnabled;

    if (this.hullEnabled) {
      this.snackBar.open('Computing concave hull...', '', { duration: 2000 });
    }

    this.frustumCulledService.setHullVisible(this.hullEnabled);

    const message = this.hullEnabled
      ? 'Concave hull visualization enabled'
      : 'Concave hull visualization disabled';

    console.log(message);
  }

  @HostListener('window:resize')
  onWindowResize(): void {
    this.updateViewportDimensions();
  }

  @HostListener('document:keydown', ['$event'])
  handleKeyboardEvent(event: KeyboardEvent) {
    // Ctrl+Z or Cmd+Z for undo
    if ((event.ctrlKey || event.metaKey) && event.key === 'z' && !event.shiftKey) {
      event.preventDefault();
      this.undo();
    }
    // Ctrl+Shift+Z or Cmd+Shift+Z or Ctrl+Y for redo
    else if (((event.ctrlKey || event.metaKey) && event.key === 'z' && event.shiftKey) ||
             ((event.ctrlKey || event.metaKey) && event.key === 'y')) {
      event.preventDefault();
      this.redo();
    }
    // Camera height controls - Q/E or PageUp/PageDown
    else if (event.key === 'q' || event.key === 'Q' || event.key === 'PageUp') {
      event.preventDefault();
      this.frustumCulledService.adjustCameraHeight(10); // Move up 10m
    }
    else if (event.key === 'e' || event.key === 'E' || event.key === 'PageDown') {
      event.preventDefault();
      this.frustumCulledService.adjustCameraHeight(-10); // Move down 10m
    }
    // R to reset view
    else if (event.key === 'r' || event.key === 'R') {
      if (!event.ctrlKey && !event.metaKey) { // Don't interfere with browser refresh
        event.preventDefault();
        this.resetView();
      }
    }
    else if (event.key === 'Escape') {
      event.preventDefault();
      this.cancelPendingClassification(false);
      this.previewPolygon = [];
      this.isLassoActive = false;
      this.lassoPoints = [];
      this.releaseLassoControls();
    }
  }


  // Project 3D world point to 2D screen coordinates
  projectToScreen(point: THREE.Vector3): {x: number, y: number} | null {
    const camera = this.frustumCulledService.getCamera();
    if (!camera) return null;

    const vector = point.clone();
    vector.project(camera as THREE.Camera);
    const rect = this.renderArea?.nativeElement.getBoundingClientRect();
    const width = rect?.width ?? this.viewWidth;
    const height = rect?.height ?? this.viewHeight;

    return {
      x: (vector.x * 0.5 + 0.5) * width,
      y: (-(vector.y * 0.5) + 0.5) * height
    };
  }

  // Get screen points for a saved measurement
  getMeasurementScreenPoints(measurement: any): {x: number, y: number}[] {
    const screenPoints: {x: number, y: number}[] = [];
    for (const point of measurement.points) {
      const screenPoint = this.projectToScreen(point);
      if (screenPoint) {
        screenPoints.push(screenPoint);
      }
    }
    return screenPoints;
  }

  // Undo/Redo operations
  undo(): void {
    const summary = this.frustumCulledService.undo();
    if (summary) {
      this.applyClassificationDeltas(summary);
      this.snackBar.open('Undo successful', '', { duration: 1000 });
    }
    this.updateUndoRedoState();
  }

  redo(): void {
    const summary = this.frustumCulledService.redo();
    if (summary) {
      this.applyClassificationDeltas(summary);
      this.snackBar.open('Redo successful', '', { duration: 1000 });
    }
    this.updateUndoRedoState();
  }

  private updateUndoRedoState(): void {
    this.canUndo = this.frustumCulledService.canUndo();
    this.canRedo = this.frustumCulledService.canRedo();
  }

  private startUndoRedoStateUpdate(): void {
    // Update undo/redo state every frame
    const updateState = () => {
      this.updateUndoRedoState();
      requestAnimationFrame(updateState);
    };
    updateState();
  }

  // Camera mode controls
  setCameraMode(mode: CameraMode): void {
    const supported: CameraMode[] = ['orbit', 'fps', 'fly'];
    const normalizedMode: CameraMode = supported.includes(mode) ? mode : 'orbit';

    this.cameraMode = normalizedMode;
    this.frustumCulledService.setCameraMode(normalizedMode);

    let icon = '🔄';
    let modeName = 'Orbit';
    let details = 'Click and drag to rotate, scroll to zoom';

    if (normalizedMode === 'fps') {
      icon = '🎮';
      modeName = 'Walk';
      details = 'Click to lock mouse, WASD to move, Shift to run, Space to ascend';
    } else if (normalizedMode === 'fly') {
      icon = '🪁';
      modeName = 'Fly';
      details = 'Free-flight with mouse look and vertical thrust';
    }

    this.addActivityLog('mode', icon, `${modeName} Mode activated`, details);
    console.log(`Camera mode set to: ${normalizedMode}`);
  }

  getCameraMode(): CameraMode {
    return this.frustumCulledService.getCameraMode();
  }

  // Slice mode controls
  async toggleSliceMode(): Promise<void> {
    this.sliceEnabled = !this.sliceEnabled;

    if (this.sliceEnabled) {
      // Get height range for slider
      const range = await this.frustumCulledService.getPointCloudHeightRange();
      if (range) {
        this.sliceMinHeight = range.min;
        this.sliceMaxHeight = range.max;
        this.sliceHeight = (range.min + range.max) / 2; // Start at middle
      }

      this.frustumCulledService.enableSliceMode(this.sliceHeight, 'horizontal');
      this.snackBar.open('✂️ Slice Mode Active - Adjust slider to cut through point cloud', 'OK', {
        duration: 3000
      });
    } else {
      this.frustumCulledService.disableSliceMode();
      this.snackBar.open('Slice Mode Disabled', 'OK', { duration: 2000 });
    }
  }

  onSliceHeightChange(): void {
    if (this.sliceEnabled) {
      this.frustumCulledService.updateSliceHeight(this.sliceHeight);
    }
  }

  // Clip box mode controls
  toggleClipBox(): void {
    this.clipBoxEnabled = !this.clipBoxEnabled;

    if (this.clipBoxEnabled) {
      this.frustumCulledService.setClipBoxFromView(this.clipBoxRadius);
      this.snackBar.open('📦 Clip Box Active - Isolating area around view', 'OK', {
        duration: 3000
      });
    } else {
      this.frustumCulledService.disableClipBox();
      this.snackBar.open('Clip Box Disabled', 'OK', { duration: 2000 });
    }
  }

  onClipBoxRadiusChange(): void {
    if (this.clipBoxEnabled) {
      this.frustumCulledService.setClipBoxFromView(this.clipBoxRadius);
    }
  }

  // X-ray mode controls
  toggleXRayMode(): void {
    this.xrayEnabled = !this.xrayEnabled;

    if (this.xrayEnabled) {
      this.frustumCulledService.enableXRayMode(this.xrayOpacity);
      this.snackBar.open('👁️ X-ray Mode Active - Classified points are now transparent', 'OK', {
        duration: 3000
      });
    } else {
      this.frustumCulledService.disableXRayMode();
      this.snackBar.open('X-ray Mode Disabled', 'OK', { duration: 2000 });
    }
  }

  onXRayOpacityChange(): void {
    if (this.xrayEnabled) {
      this.frustumCulledService.updateXRayOpacity(this.xrayOpacity);
    }
  }

  // Height preset controls
  async jumpToGroundLevel(): Promise<void> {
    await this.frustumCulledService.jumpToGroundLevel();
    this.addActivityLog('camera', '🏞️', 'Jumped to Ground Level');
  }

  async jumpToMidLevel(): Promise<void> {
    await this.frustumCulledService.jumpToMidLevel();
    this.addActivityLog('camera', '🏙️', 'Jumped to Mid Level');
  }

  async jumpToAerialView(): Promise<void> {
    await this.frustumCulledService.jumpToAerialView();
    this.addActivityLog('camera', '🛩️', 'Jumped to Aerial View');
  }

  // Bottom panel controls
  toggleBottomPanel(): void {
    this.bottomPanelOpen = !this.bottomPanelOpen;
  }

  // Right sidebar controls
  toggleSidebar(): void {
    this.sidebarOpen = !this.sidebarOpen;
  }

  toggleSection(section: keyof typeof this.sectionsExpanded): void {
    this.sectionsExpanded[section] = !this.sectionsExpanded[section];
  }

  // Floating panel controls
  toggleStatisticsPanel(): void {
    this.statisticsPanelOpen = !this.statisticsPanelOpen;
    if (this.statisticsPanelOpen) {
      this.settingsPanelOpen = false;
      this.measurementsPanelOpen = false;
      this.polePanelOpen = false;
    }
  }

  toggleSettingsPanel(): void {
    this.settingsPanelOpen = !this.settingsPanelOpen;
    if (this.settingsPanelOpen) {
      this.statisticsPanelOpen = false;
      this.measurementsPanelOpen = false;
      this.polePanelOpen = false;
    }
  }

  // Display settings
  onPointSizeChange(): void {
    // Point size is already handled by existing pointSize property
    // The frustumCulledService uses this.pointSize directly
    this.frustumCulledService.setPointSize(this.pointSize);
    this.saveDisplayPreferences();
  }

  onPointBudgetChange(): void {
    this.frustumCulledService.setPointBudget(this.pointBudget);
    this.saveDisplayPreferences();
  }

  setBackgroundColor(color: 'black' | 'white' | 'gray'): void {
    this.backgroundColor = color;
    this.frustumCulledService.setBackgroundColor(color);
    this.saveDisplayPreferences();
  }

  // Screenshot
  captureScreenshot(): void {
    // Use the existing exportImage method from the service
    this.frustumCulledService.exportImage();
  }

  private loadDisplayPreferences(): void {
    if (!this.hasLocalStorage()) {
      this.applyClassificationOverridesToClassifications();
      this.syncClassificationColorsToService();
      return;
    }

    const raw = localStorage.getItem(this.displayPrefsKey);
    if (!raw) {
      this.applyClassificationOverridesToClassifications();
      this.syncClassificationColorsToService();
      return;
    }

    try {
      const prefs = JSON.parse(raw) as DisplayPreferences;
      if (typeof prefs.pointSize === 'number') {
        this.pointSize = prefs.pointSize;
        this.frustumCulledService.setPointSize(this.pointSize);
      }
      if (typeof prefs.pointBudget === 'number') {
        this.pointBudget = prefs.pointBudget;
        this.frustumCulledService.setPointBudget(this.pointBudget);
      }
      if (prefs.backgroundColor === 'black' || prefs.backgroundColor === 'white' || prefs.backgroundColor === 'gray') {
        this.backgroundColor = prefs.backgroundColor;
        this.frustumCulledService.setBackgroundColor(this.backgroundColor);
      }
      if (typeof prefs.edlEnabled === 'boolean') {
        this.edlEnabled = prefs.edlEnabled;
        this.frustumCulledService.setEDLEnabled(this.edlEnabled);
      }
      if (prefs.classificationColors && typeof prefs.classificationColors === 'object') {
        const sanitized: Record<number, string> = {};
        Object.entries(prefs.classificationColors).forEach(([key, value]) => {
          const numericKey = Number(key);
          const normalized = this.normalizeHexColor(value as string);
          if (!Number.isNaN(numericKey) && normalized) {
            sanitized[numericKey] = normalized;
          }
        });
        this.classificationColorOverrides = sanitized;
      }

      this.applyClassificationOverridesToClassifications();
      this.syncClassificationColorsToService();
    } catch (error) {
      console.warn('Failed to load display preferences', error);
    }
  }

  private saveDisplayPreferences(): void {
    if (!this.hasLocalStorage()) {
      return;
    }

    const payload: DisplayPreferences = {
      pointSize: this.pointSize,
      pointBudget: this.pointBudget,
      backgroundColor: this.backgroundColor,
      edlEnabled: this.edlEnabled,
      classificationColors: this.classificationColorOverrides
    };

    localStorage.setItem(this.displayPrefsKey, JSON.stringify(payload));
    this.saveClassificationColorHistory();
  }

  private hasLocalStorage(): boolean {
    return typeof window !== 'undefined' && typeof localStorage !== 'undefined';
  }

  private loadClassificationColorHistory(): void {
    if (!this.hasLocalStorage()) {
      return;
    }
    const raw = localStorage.getItem(this.classificationColorHistoryKey);
    if (!raw) {
      return;
    }
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        const sanitized = parsed
          .map(entry => this.normalizeHexColor(typeof entry === 'string' ? entry : ''))
          .filter((val): val is string => !!val);
        this.recentClassificationColors = sanitized.slice(0, 6);
      }
    } catch (error) {
      console.warn('Failed to load classification color history', error);
    }
  }

  private saveClassificationColorHistory(): void {
    if (!this.hasLocalStorage()) {
      return;
    }
    localStorage.setItem(this.classificationColorHistoryKey, JSON.stringify(this.recentClassificationColors));
  }

  private applyClassificationOverridesToClassifications(): void {
    this.classifications = this.classifications.map(c => ({
      ...c,
      color: this.resolveClassificationColor(c)
    }));
    this.refreshClassificationPalette();
  }

  private resolveClassificationColor(classification: Classification): string {
    const values = this.getClassificationValues(classification);
    for (const value of values) {
      const override = this.normalizeHexColor(this.classificationColorOverrides?.[value]);
      if (override) {
        return override;
      }
    }

    const fallback = this.normalizeHexColor(classification.defaultColor ?? classification.color);
    return fallback ?? '#9CA3AF';
  }

  private buildClassificationColorMap(): Record<number, string> {
    const palette: Record<number, string> = {};
    this.classifications.forEach(classification => {
      const color = this.resolveClassificationColor(classification);
      const values = this.getClassificationValues(classification);
      values.forEach(value => {
        if (palette[value] === undefined) {
          palette[value] = color;
        }
      });
    });
    Object.entries(this.classificationColorOverrides ?? {}).forEach(([key, value]) => {
      const numericKey = Number(key);
      const normalized = this.normalizeHexColor(value);
      if (!Number.isNaN(numericKey) && normalized && palette[numericKey] === undefined) {
        palette[numericKey] = normalized;
      }
    });
    return palette;
  }

  private recoloringInProgress = false;

  private recolorActivePointCloud(): void {
    const pointCloudId = this.activePointCloudId ?? this.currentPointCloud?.id;
    if (!pointCloudId || this.recoloringInProgress) {
      return;
    }
    const palette = this.buildClassificationColorMap();
    this.recoloringInProgress = true;
    this.api.recolorPointCloud(pointCloudId, palette).pipe(take(1)).subscribe({
      next: (response) => {
        console.log('✅ Recolored point cloud file', response);
        this.snackBar.open('Recolored point cloud file with new palette', 'OK', { duration: 2500 });
      },
      error: (err) => {
        const detail = err?.error?.detail || err?.message || 'Unknown error';
        console.error('Failed to recolor point cloud file', err);
        this.snackBar.open(`Failed to recolor file: ${detail}`, 'Dismiss', { duration: 5000 });
      },
      complete: () => {
        this.recoloringInProgress = false;
      }
    });
  }

  private syncClassificationColorsToService(): void {
    const palette = this.buildClassificationColorMap();
    this.frustumCulledService.setClassificationColors(palette);
    this.frustumCulledService.setColorScheme('classification');
  }

  // Activity log
  private activityIdCounter = 1;

  addActivityLog(type: ActivityLogEntry['type'], icon: string, message: string, details?: string): void {
    const entry: ActivityLogEntry = {
      id: this.activityIdCounter++,
      timestamp: new Date(),
      type,
      icon,
      message,
      details
    };

    this.activityLog.unshift(entry);

    // Keep only last N entries
    if (this.activityLog.length > this.maxActivityLog) {
      this.activityLog = this.activityLog.slice(0, this.maxActivityLog);
    }
  }

  clearActivityLog(): void {
    this.activityLog = [];
  }

  formatTimestamp(date: Date): string {
    return date.toLocaleTimeString();
  }

  getActiveLassoPointsAttribute(): string {
    const points = [...this.lassoPoints];
    if (this.isLassoActive) {
      points.push({ x: this.currentMousePos.x, y: this.currentMousePos.y });
    }
    return points.map(p => `${p.x},${p.y}`).join(' ');
  }

  getPreviewPolygonAttribute(): string {
    if (!this.previewPolygon.length) {
      return '';
    }
    return [...this.previewPolygon, this.previewPolygon[0]]
      .map(p => `${p.x},${p.y}`)
      .join(' ');
  }

  private releaseLassoControls(): void {
    if (this.lassoControlsLocked) {
      this.frustumCulledService.setCameraControlsEnabled(true);
      this.lassoControlsLocked = false;
    }
  }

  async applyPendingClassification(): Promise<void> {
    if (!this.pendingClassification) {
      return;
    }

    const { points: pendingPoints, polygon, target, source } = this.pendingClassification;
    if (!pendingPoints || pendingPoints.length === 0) {
      this.snackBar.open('Nothing to apply for this lasso.', '', { duration: 1500 });
      this.cancelPendingClassification(false);
      return;
    }
    this.selectionProgress = 'Applying classification...';
    this.updateViewportDimensions();

    const points = pendingPoints;

    if (!points || points.length === 0) {
      this.frustumCulledService.clearClassificationPreview();
      this.pendingClassification = null;
      this.previewPolygon = [];
      this.isSelecting = false;
      this.selectionProgress = '';
      this.snackBar.open('No points matched the source class.', '', { duration: 2000 });
      this.releaseLassoControls();
      return;
    }

    const color = new THREE.Color(target.color);
    const sourceValues = this.getClassificationValues(source);
    const sourceFilter = sourceValues.length === 1 ? sourceValues[0] : sourceValues;

    // Restore original point attributes before applying so source filtering works
    this.frustumCulledService.clearClassificationPreview();

    const summary = await this.frustumCulledService.updatePointClassification(
      points,
      target.value,
      color,
      sourceFilter
    );

    this.pendingClassification = null;
    this.previewPolygon = [];
    this.frustumCulledService.clearClassificationPreview();
    this.isSelecting = false;
    this.selectionProgress = '';
    this.releaseLassoControls();

    if (summary && summary.totalPoints > 0) {
      this.applyClassificationDeltas(summary);
      this.persistClassificationChange(points, source, target, polygon);
      this.addActivityLog(
        'classification',
        '✏️',
        `Applied ${this.formatPointCount(summary.totalPoints)} points`,
        `${source.name} → ${target.name}`
      );
      this.snackBar.open(
        `Applied ${this.formatPointCount(summary.totalPoints)} points`,
        '',
        { duration: 2000 }
      );
    } else {
      this.snackBar.open('No points matched the source class.', '', { duration: 2000 });
    }
    this.releaseLassoControls();
  }

  onApplyPendingClassification(event: MouseEvent): void {
    event.preventDefault();
    event.stopPropagation();
    this.applyPendingClassification();
  }

  onDiscardPendingClassification(event: MouseEvent): void {
    event.preventDefault();
    event.stopPropagation();
    this.cancelPendingClassification();
  }

  cancelPendingClassification(showMessage: boolean = true): void {
    if (this.pendingClassification && showMessage) {
      this.snackBar.open('Preview discarded', '', { duration: 1500 });
    }
    this.pendingClassification = null;
    this.frustumCulledService.clearClassificationPreview();
    this.isSelecting = false;
    this.isLassoActive = false;
    this.lassoPoints = [];
    this.selectionProgress = '';
    this.previewPolygon = [];
    this.releaseLassoControls();
  }

  private persistClassificationChange(
    points: SelectedPoint[],
    source: Classification,
    target: Classification,
    polygon: Array<{ x: number; y: number }>
  ): void {
    const pointCloudId = this.activePointCloudId;
    if (!pointCloudId) {
      console.warn('Cannot persist classification edits: no active point cloud ID.');
      return;
    }

    const identifiers = points
      .map(point => point.identifier)
      .filter((id): id is NonNullable<typeof id> => !!id);

    if (identifiers.length === 0) {
      console.warn('Classification edits could not be persisted because no stable point identifiers were available; falling back to offsets.');

      const fallbackIdentifiers = points.map((point, index) => ({
        tileKey: point.object?.name ?? `fallback:${index}`,
        pointIndex: point.index,
        sourceId: undefined,
        unstable: true
      }));

      identifiers.push(...fallbackIdentifiers);
    }

    if (identifiers.length !== points.length) {
      console.warn(
        `Only ${identifiers.length} of ${points.length} selected points had stable identifiers; persisting available subset.`
      );
      this.snackBar.open(
        `Saved ${this.formatPointCount(identifiers.length)} of ${this.formatPointCount(points.length)} points (missing identifiers).`,
        'OK',
        { duration: 4000 }
      );
    }

    const unstableCount = identifiers.reduce((count, id) => (id.unstable ? count + 1 : count), 0);

    const previousClassValue = this.getPreviousClassValueForPersistence(points, source);

    const payload: ClassificationEditRequest = {
      operations: [
        {
          newClass: target.value,
          previousClass: previousClassValue,
          points: identifiers.map(({ tileKey, pointIndex, sourceId, unstable }) => ({
            tileKey,
            pointIndex,
            sourceId,
            unstable
          })),
          metadata: {
            selectionMode: 'lasso',
            totalSelected: points.length,
            polygonVertices: polygon.length,
            viewport: { width: this.viewWidth, height: this.viewHeight },
            unstableIdentifiers: unstableCount || undefined
          }
        }
      ],
      clientTimestamp: new Date().toISOString()
    };

    console.log('[classification] prepared payload', payload);

    const immediateOverrides: Record<string, Record<string, number>> = {};
    identifiers.forEach(({ tileKey, pointIndex }) => {
      if (!tileKey) {
        return;
      }
      if (!immediateOverrides[tileKey]) {
        immediateOverrides[tileKey] = {};
      }
      immediateOverrides[tileKey][String(pointIndex)] = target.value;
    });

    this.ensureClassificationPalette();
    this.frustumCulledService.setClassificationOverrides(immediateOverrides, this.classificationPalette, true);

    this.enqueueClassificationSave(pointCloudId, payload, {
      totalPoints: identifiers.length,
      selectionMode: 'lasso',
      targetClass: target.value,
      sourceClass: previousClassValue,
      unstableIdentifiers: unstableCount
    });

    this.scheduleOverridesRefresh(500);
  }

  private enqueueClassificationSave(
    pointCloudId: number,
    request: ClassificationEditRequest,
    summary: ClassificationSaveSummary
  ): void {
    const queueItem: ClassificationSaveQueueItem = {
      pointCloudId,
      request,
      summary,
      attempts: 0
    };

    this.classificationSaveQueue.push(queueItem);
    this.lastClassificationSaveSummary = summary;
    this.classificationSaveStatus = this.classificationSaveInFlight ? 'saving' : 'queued';
    if (!this.classificationSaveInFlight) {
      this.selectionProgress = 'Queued classification save…';
    }

    console.log('[classification] enqueued save', queueItem);

    this.addActivityLog(
      'classification',
      '📤',
      `Queued server sync for ${this.formatPointCount(summary.totalPoints)} points`,
      `${summary.sourceClass ?? 'any'} → ${summary.targetClass}`
    );

    this.processClassificationSaveQueue();
  }

  private processClassificationSaveQueue(): void {
    if (this.classificationSaveInFlight) {
      return;
    }

    const next = this.classificationSaveQueue.shift();
    if (!next) {
      if (this.failedClassificationSaves.length === 0) {
        this.classificationSaveStatus = 'idle';
        if (this.selectionProgress.startsWith('Saving') || this.selectionProgress.includes('Queued')) {
          this.selectionProgress = '';
        }
        this.lastClassificationSaveSummary = null;
        this.lastClassificationOperationId = null;
      } else {
        this.classificationSaveStatus = 'error';
        this.selectionProgress = 'Classification save failed. Tap retry to re-send.';
      }
      return;
    }

    this.classificationSaveInFlight = true;
    next.attempts += 1;
    this.classificationSaveStatus = 'saving';
    this.selectionProgress = 'Saving classification edits…';
    this.lastClassificationSaveSummary = next.summary;

    console.log('[classification] calling applyClassificationEdits', next);

    this.api
      .applyClassificationEdits(next.pointCloudId, next.request)
      .pipe(take(1), takeUntil(this.destroy$))
      .subscribe({
        next: response => {
          this.classificationSaveInFlight = false;
          this.classificationSaveStatus = 'success';
          this.lastClassificationOperationId = response.operationId;
          this.selectionProgress = 'Classification edits saved.';
          this.addActivityLog(
            'classification',
            '✅',
            `Server confirmed ${this.formatPointCount(next.summary.totalPoints)} points`,
            `Operation ${response.operationId}`
          );
          this.scheduleOverridesRefresh(250);

          setTimeout(() => {
            if (this.selectionProgress === 'Classification edits saved.') {
              this.selectionProgress = '';
            }
            if (this.classificationSaveStatus === 'success') {
              this.classificationSaveStatus = 'idle';
              this.lastClassificationSaveSummary = null;
              this.lastClassificationOperationId = null;
            }
          }, 2000);

          this.processClassificationSaveQueue();
        },
        error: err => {
          this.classificationSaveInFlight = false;

          if (next.attempts < this.maxClassificationSaveAttempts) {
            console.warn('Retrying classification save (attempt %d)', next.attempts + 1);
            this.classificationSaveQueue.unshift(next);
            this.classificationSaveStatus = 'queued';
            this.selectionProgress = 'Retrying classification save…';
            setTimeout(() => this.processClassificationSaveQueue(), 2000);
            return;
          }

          this.classificationSaveStatus = 'error';
          this.failedClassificationSaves.push(next);
          this.selectionProgress = 'Classification save failed.';
          console.error('Failed to persist classification edits:', err);
          this.addActivityLog(
            'classification',
            '⚠️',
            'Server persistence failed',
            err?.message ?? 'Unknown error'
          );

          this.snackBar
            .open(
              'Could not persist classification change. Tap RETRY to try again.',
              'RETRY',
              { duration: 6000 }
            )
            .onAction()
            .pipe(take(1), takeUntil(this.destroy$))
            .subscribe(() => this.retryFailedClassificationSaves());
        }
      });
  }

  private scheduleOverridesRefresh(delay: number = 300): void {
    if (!this.activePointCloudId) {
      return;
    }

    if (this.overridesRefreshHandle !== null) {
      window.clearTimeout(this.overridesRefreshHandle);
    }

    this.overridesRefreshHandle = window.setTimeout(() => {
      this.overridesRefreshHandle = null;
      this.loadClassificationOverrides();
      this.scheduleStatusPoll(0);
    }, delay);
  }

  private loadClassificationOverrides(): void {
    const pointCloudId = this.activePointCloudId;
    if (!pointCloudId) {
      return;
    }

    this.api
      .getClassificationOverrides(pointCloudId)
      .pipe(take(1), takeUntil(this.destroy$))
      .subscribe({
        next: overrides => {
          this.ensureClassificationPalette();
          this.frustumCulledService.setClassificationOverrides(
            overrides ?? {},
            this.classificationPalette
          );
        },
        error: err => {
          console.warn('Failed to load classification overrides', err);
        }
      });
  }

  private scheduleStatusPoll(delay: number = 2000): void {
    if (!this.activePointCloudId) {
      return;
    }

    if (this.classificationStatusPollHandle !== null) {
      window.clearTimeout(this.classificationStatusPollHandle);
    }

    this.classificationStatusPollHandle = window.setTimeout(() => {
      this.classificationStatusPollHandle = null;
      this.pollClassificationStatus();
    }, delay);
  }

  private pollClassificationStatus(): void {
    const pointCloudId = this.activePointCloudId;
    if (!pointCloudId) {
      return;
    }

    this.api
      .getClassificationStatus(pointCloudId)
      .pipe(take(1), takeUntil(this.destroy$))
      .subscribe({
        next: statuses => {
          this.classificationStatuses = statuses.map(status => {
            const tilesTotal = status.tilesTotal || 0;
            const tilesProcessed = status.tilesProcessed || 0;
            const totalPoints = status.totalPoints || 0;
            const pointsProcessed = status.pointsProcessed || 0;
            let progress = 0;
            if (tilesTotal > 0) {
              progress = (tilesProcessed / Math.max(tilesTotal, 1)) * 100;
            } else if (totalPoints > 0) {
              progress = (pointsProcessed / Math.max(totalPoints, 1)) * 100;
            }
            progress = Math.max(0, Math.min(100, progress));
            return {
              ...status,
              progressPercent: progress,
            } as ClassificationBatchStatus;
          });

          this.updateClassificationSaveStateFromStatuses();

          if (this.classificationStatuses.some(batch => batch.status === 'queued' || batch.status === 'processing')) {
            this.scheduleStatusPoll();
          }
        },
        error: err => {
          console.warn('Failed to load classification status', err);
        }
      });
  }

  private updateClassificationSaveStateFromStatuses(): void {
    const latestId = this.lastClassificationOperationId;
    const activeBatch = this.activeClassificationBatch;

    if (activeBatch) {
      this.classificationSaveStatus = activeBatch.status === 'queued' ? 'queued' : 'saving';
      return;
    }

    if (latestId) {
      const latestBatch = this.classificationStatuses.find(batch => batch.operationId === latestId);
      if (latestBatch) {
        if (latestBatch.status === 'completed') {
          this.classificationSaveStatus = 'success';
        } else if (latestBatch.status === 'failed') {
          this.classificationSaveStatus = 'error';
        }
      }
    }

    if (!this.classificationStatuses.length) {
      this.classificationSaveStatus = 'idle';
    }
  }

  retryFailedClassificationSaves(): void {
    if (this.failedClassificationSaves.length === 0) {
      return;
    }

    this.failedClassificationSaves.forEach(item => {
      item.attempts = 0;
      this.classificationSaveQueue.push(item);
      this.lastClassificationSaveSummary = item.summary;
    });

    this.failedClassificationSaves = [];
    this.classificationSaveStatus = 'queued';
    this.selectionProgress = 'Retrying failed classification saves…';
    this.processClassificationSaveQueue();
  }

  dismissClassificationStatus(): void {
    if (this.classificationSaveStatus === 'saving' || this.classificationSaveStatus === 'queued') {
      return;
    }

    this.failedClassificationSaves = [];
    this.classificationSaveStatus = 'idle';
    this.lastClassificationSaveSummary = null;
    this.lastClassificationOperationId = null;
    if (!this.classificationSaveInFlight) {
      this.selectionProgress = '';
    }
  }

  get classificationSaveQueueDepth(): number {
    return this.classificationSaveQueue.length;
  }

  get classificationStatusIcon(): string {
    switch (this.classificationSaveStatus) {
      case 'queued':
        return 'schedule';
      case 'saving':
        return 'autorenew';
      case 'success':
        return 'check_circle';
      case 'error':
        return 'warning';
      default:
        return 'info';
    }
  }

  get classificationStatusMessage(): string {
    const summary = this.lastClassificationSaveSummary;
    const pointLabel = summary ? this.formatPointCount(summary.totalPoints) : 'selected';
    const activeBatch = this.activeClassificationBatch;

    switch (this.classificationSaveStatus) {
      case 'queued':
        if (activeBatch) {
          return `Queued ${this.formatPointCount(activeBatch.totalPoints)} points (${activeBatch.progressPercent.toFixed(1)}% ready)`;
        }
        return `Queued ${pointLabel} points for server save`;
      case 'saving':
        if (activeBatch) {
          return `Processing ${this.formatPointCount(activeBatch.totalPoints)} points – ${activeBatch.progressPercent.toFixed(1)}%`; 
        }
        return `Saving ${pointLabel} points to server…`;
      case 'success':
        return `Saved ${pointLabel} points to server`;
      case 'error':
        return `Failed to save ${pointLabel} points`;
      default:
        return '';
    }
  }

  get activeClassificationBatch(): ClassificationBatchStatus | null {
    return this.classificationStatuses.find(batch => batch.status === 'processing' || batch.status === 'queued') ?? null;
  }

  private initializeClassificationCounts(pointCloud: PointCloud): void {
    this.classificationValueCounts = new Map<number, number>();
    this.classificationStatuses = [];
    this.scheduleStatusPoll(0);

    const classificationStats = pointCloud.classification;
    if (classificationStats) {
      Object.entries(classificationStats).forEach(([key, value]) => {
        const count = typeof value === 'number' ? value : Number(value);
        if (!Number.isFinite(count)) {
          return;
        }

        const numericKey = Number(key);
        if (!Number.isNaN(numericKey)) {
          this.classificationValueCounts.set(
            numericKey,
            (this.classificationValueCounts.get(numericKey) ?? 0) + count
          );
          return;
        }

        const keyUpper = key.toUpperCase();
        const match = this.classifications.find(c =>
          c.name.toUpperCase() === keyUpper || c.aliases?.some(alias => alias.toUpperCase() === keyUpper)
        );

        if (match) {
          this.classificationValueCounts.set(
            match.value,
            (this.classificationValueCounts.get(match.value) ?? 0) + count
          );
        }
      });
    }

    this.refreshClassificationSummaries();
    this.refreshClassificationPalette();
    this.scheduleOverridesRefresh(0);

    // Initialize classification visibility (all visible by default)
    this.initializeClassificationVisibility();
  }

  /**
   * Build a classification list tailored to the current point cloud.
   * Only include classes present in the dataset; add placeholders for unknown IDs.
   */
  /**
   * Update baseClassificationDefinitions from backend color schemes
   */
  private updateClassificationDefinitionsFromSchemes(schemes: any[]): void {
    const standardByValue = new Map<number, Classification>(
      this.standardClassificationDefinitions.map(def => [def.value, def])
    );

    const merged = new Map<number, Classification>();

    schemes.forEach(scheme => {
      const value: number = scheme.classification_value;
      const standard = standardByValue.get(value);
      merged.set(value, {
        id: value,
        value,
        name: scheme.name ?? standard?.name ?? `Class ${value}`,
        color: scheme.color,
        defaultColor: scheme.color,
        custom: standard?.custom ?? !scheme.auto_generated,
        pointCount: 0,
        aliases: this.getAliasesForClassification(scheme.name) ?? standard?.aliases,
        matchValues: value === 1 ? [0, 1] : standard?.matchValues
      });
    });

    // Ensure all standard classifications remain present (even if missing from backend response)
    this.standardClassificationDefinitions.forEach(def => {
      if (!merged.has(def.value)) {
        merged.set(def.value, { ...def, pointCount: 0 });
      }
    });

    this.baseClassificationDefinitions = Array.from(merged.values()).sort((a, b) => a.value - b.value);
    this.classifications = this.baseClassificationDefinitions.map(def => ({ ...def }));
    console.log(`✅ Updated ${this.baseClassificationDefinitions.length} classification definitions from backend (with standard fallbacks)`);
  }

  /**
   * Refresh classifications (definitions, counts, palette) for the active point cloud,
   * preferring point-cloud-specific colors from the backend when available.
   */
  private refreshClassificationsForPointCloud(pointCloud: PointCloud): void {
    // Fetch point-cloud-specific schemes; fall back to global if unavailable
    this.classificationColorService.loadPointCloudColorSchemes(pointCloud.id).pipe(take(1)).subscribe({
      next: (pcSchemes) => {
        if (pcSchemes && pcSchemes.length > 0) {
          this.updateClassificationDefinitionsFromSchemes(pcSchemes);
        } else {
          // No per-cloud schemes; keep current base definitions
          console.log('No point-cloud-specific color schemes returned; using current definitions');
        }
        this.buildClassificationsForPointCloud(pointCloud);
        if (this.currentColorMode === 'classification') {
          this.syncClassificationColorsToService();
          this.frustumCulledService.refreshClassificationColorLUT();
        }
      },
      error: (err) => {
        console.warn('Failed to load point-cloud-specific color schemes; using existing definitions', err);
        this.buildClassificationsForPointCloud(pointCloud);
        if (this.currentColorMode === 'classification') {
          this.syncClassificationColorsToService();
          this.frustumCulledService.refreshClassificationColorLUT();
        }
      }
    });
  }

  /**
   * Get standard aliases for a classification name
   */
  private getAliasesForClassification(name: string): string[] | undefined {
    const aliasMap: Record<string, string[]> = {
      'Unclassified': ['UNCLASSIFIED', 'UNASSIGNED'],
      'Low Veg': ['LOW VEGETATION'],
      'Medium Veg': ['MEDIUM VEGETATION'],
      'High Veg': ['HIGH VEGETATION'],
      'Building': ['BUILDING', 'BUILDINGS'],
      'Noise': ['LOW POINT (NOISE)', 'HIGH NOISE'],
      'Model Key-Point': ['MODEL KEY-POINT'],
      'Overlap': ['OVERLAP', 'OVERLAP DEFAULT'],
      'Wire Guard': ['WIRE GUARD'],
      'Wire - Conductor': ['WIRE - CONDUCTOR', 'CONDUCTOR'],
      'Wire - Guy Wire': ['WIRE - GUY WIRE'],
      'Wire - Secondary': ['WIRE - SECONDARY']
    };
    return aliasMap[name];
  }

  private buildClassificationsForPointCloud(pointCloud: PointCloud): void {
    const stats = pointCloud.classification ?? {};

    // Start from the full standard set so everything stays selectable
    const classifications = this.baseClassificationDefinitions.map(def => ({ ...def, pointCount: 0 }));

    Object.entries(stats).forEach(([key, rawCount]) => {
      const count = typeof rawCount === 'number' ? rawCount : Number(rawCount);
      if (!Number.isFinite(count)) {
        return;
      }

      const numericKey = Number(key);
      const normalizedName = key.toString().trim().toUpperCase();

      const existingIndex = classifications.findIndex(c => {
        const matchesValue = !Number.isNaN(numericKey) && (c.value === numericKey || c.matchValues?.includes(numericKey));
        const matchesName = c.name.toUpperCase() === normalizedName || (c.aliases ?? []).some(alias => alias.toUpperCase() === normalizedName);
        return matchesValue || matchesName;
      });

      if (existingIndex !== -1) {
        classifications[existingIndex] = {
          ...classifications[existingIndex],
          pointCount: (classifications[existingIndex].pointCount ?? 0) + count
        };
        return;
      }

      if (!Number.isNaN(numericKey)) {
        classifications.push({
          id: numericKey,
          value: numericKey,
          name: `Class ${numericKey}`,
          color: '#888888',
          defaultColor: '#888888',
          custom: true,
          pointCount: count
        });
      }
    });

    this.classifications = classifications;
    this.applyClassificationOverridesToClassifications();
  }

  /**
   * Initialize classification visibility state (all visible by default)
   */
  private initializeClassificationVisibility(): void {
    this.classificationVisibility.clear();

    // Initialize all classifications as visible
    this.classifications.forEach(classification => {
      this.classificationVisibility.set(classification.value, true);

      // Also initialize any match values
      classification.matchValues?.forEach(value => {
        this.classificationVisibility.set(value, true);
      });
    });

    console.log(`Initialized visibility for ${this.classificationVisibility.size} classification values`);
  }

  /**
   * Toggle visibility for a specific classification
   */
  toggleClassificationVisibility(classification: Classification): void {
    const currentVisibility = this.classificationVisibility.get(classification.value) ?? true;
    const newVisibility = !currentVisibility;

    // Update local state
    this.classificationVisibility.set(classification.value, newVisibility);

    // Also update match values if any
    classification.matchValues?.forEach(value => {
      this.classificationVisibility.set(value, newVisibility);
    });

    // Update the service (which updates Giro3D's shader and selection filter)
    this.frustumCulledService.setClassificationVisibility(classification.value, newVisibility);

    // Also update match values in the service
    classification.matchValues?.forEach(value => {
      this.frustumCulledService.setClassificationVisibility(value, newVisibility);
    });

    console.log(`Classification "${classification.name}" visibility: ${newVisibility}`);
  }

  /**
   * Check if a classification is currently visible
   */
  isClassificationVisible(classification: Classification): boolean {
    return this.classificationVisibility.get(classification.value) ?? true;
  }

  /**
   * Show all classifications
   */
  showAllClassifications(): void {
    this.classifications.forEach(classification => {
      this.classificationVisibility.set(classification.value, true);
      classification.matchValues?.forEach(value => {
        this.classificationVisibility.set(value, true);
      });
    });

    this.frustumCulledService.showAllClassifications();
    console.log('All classifications shown');
  }

  /**
   * Hide all classifications
   */
  hideAllClassifications(): void {
    this.classifications.forEach(classification => {
      this.classificationVisibility.set(classification.value, false);
      classification.matchValues?.forEach(value => {
        this.classificationVisibility.set(value, false);
      });
    });

    this.frustumCulledService.hideAllClassifications();
    console.log('All classifications hidden');
  }

  private getClassificationValues(classification: Classification): number[] {
    const values = new Set<number>();
    values.add(classification.value);
    classification.matchValues?.forEach(value => values.add(value));
    return Array.from(values);
  }

  private getClassificationPointCount(
    classification: Classification,
    sourceCounts: Map<number, number>
  ): number {
    return this.getClassificationValues(classification)
      .reduce((sum, value) => sum + (sourceCounts.get(value) ?? 0), 0);
  }

  private calculateTotalClassifiedPoints(sourceCounts: Map<number, number>): number {
    let total = 0;
    sourceCounts.forEach(count => {
      total += count;
    });
    return total;
  }

  private refreshClassificationSummaries(): void {
    this.classifications.forEach(classification => {
      classification.pointCount = this.getClassificationPointCount(classification, this.classificationValueCounts);
    });
    this.classifiedPoints = this.calculateTotalClassifiedPoints(this.classificationValueCounts);
    this.syncSelectedClassifications();
  }

  private refreshClassificationPalette(): void {
    this.classificationPalette.clear();
    this.classifications.forEach(classification => {
      const resolvedColor = this.resolveClassificationColor(classification);
      try {
        const color = new THREE.Color(resolvedColor);
        const values = this.getClassificationValues(classification);
        values.forEach(value => {
          if (!this.classificationPalette.has(value)) {
            this.classificationPalette.set(value, color);
          }
        });
      } catch (error) {
        console.warn('Failed to parse classification color', resolvedColor, error);
      }
    });
    Object.entries(this.classificationColorOverrides ?? {}).forEach(([key, value]) => {
      const numericKey = Number(key);
      const normalized = this.normalizeHexColor(value);
      if (!Number.isNaN(numericKey) && normalized && !this.classificationPalette.has(numericKey)) {
        try {
          this.classificationPalette.set(numericKey, new THREE.Color(normalized));
        } catch (error) {
          console.warn('Failed to parse override classification color', normalized, error);
        }
      }
    });
  }

  private ensureClassificationPalette(): void {
    if (this.classificationPalette.size === 0) {
      this.refreshClassificationPalette();
    }
  }

  private getPreviousClassValueForPersistence(
    _points: SelectedPoint[],
    classification: Classification | null
  ): number | null {
    if (!classification) {
      return null;
    }
    const values = this.getClassificationValues(classification);
    return values.length === 1 ? values[0] : null;
  }

  private syncSelectedClassifications(): void {
    if (!this.selectedClassification) {
      this.selectedClassification = this.classifications.find(c => c.value === 2) ?? this.classifications[0];
    } else {
      const refreshed = this.classifications.find(c => c.id === this.selectedClassification?.id);
      if (refreshed) {
        this.selectedClassification = refreshed;
      }
    }

    if (!this.selectedSourceClassification) {
      this.selectedSourceClassification = this.classifications[0];
    } else {
      const refreshedSource = this.classifications.find(c => c.id === this.selectedSourceClassification?.id);
      if (refreshedSource) {
        this.selectedSourceClassification = refreshedSource;
      }
    }
  }

  private applyClassificationDeltas(summary: ClassificationChangeSummary | null): void {
    if (!summary || !summary.deltas) {
      return;
    }

    Object.entries(summary.deltas).forEach(([idString, delta]) => {
      const classId = Number(idString);
      if (Number.isNaN(classId) || delta === 0) {
        return;
      }

      const current = this.classificationValueCounts.get(classId) ?? 0;
      const updated = Math.max(0, current + delta);
      this.classificationValueCounts.set(classId, updated);
    });

    this.refreshClassificationSummaries();
  }

  // Lasso selection methods
  private startLassoSelection(x: number, y: number): void {
    if (!this.selectedClassification) {
      this.snackBar.open('Please select a classification first', 'OK', { duration: 2000 });
      return;
    }
    if (!this.selectedSourceClassification) {
      this.snackBar.open('Choose a source class to replace before drawing the lasso', 'OK', { duration: 2000 });
      return;
    }
    if (this.selectedSourceClassification.value === this.selectedClassification.value) {
      this.snackBar.open('Source and target classes are the same. Pick a different target.', 'OK', { duration: 2000 });
      return;
    }

    this.cancelPendingClassification(false);
    this.previewPolygon = [];
    this.updateViewportDimensions();
    const pointer = this.getPointerPosition(x, y);
    if (!this.lassoControlsLocked) {
      this.frustumCulledService.setCameraControlsEnabled(false);
      this.lassoControlsLocked = true;
    }

    this.isLassoActive = true;
    this.lassoPoints = [pointer];
    this.currentMousePos = pointer;
    console.log('Lasso selection started');
  }

  private updateLassoSelection(x: number, y: number): void {
    if (!this.isLassoActive) return;

    const pointer = this.getPointerPosition(x, y);
    // Add point if it's far enough from the last point (to avoid too many points)
    const lastPoint = this.lassoPoints[this.lassoPoints.length - 1];
    const distance = Math.sqrt(Math.pow(pointer.x - lastPoint.x, 2) + Math.pow(pointer.y - lastPoint.y, 2));

    if (distance > 5) { // Minimum 5 pixels between points
      this.lassoPoints.push(pointer);
    }
    this.currentMousePos = pointer;
  }

  private async completeLassoSelection(): Promise<void> {
    if (!this.isLassoActive || this.lassoPoints.length < 3 || !this.selectedClassification) {
      this.isLassoActive = false;
      this.lassoPoints = [];
      this.previewPolygon = [];
      this.releaseLassoControls();
      return;
    }

    console.log(`Lasso selection with ${this.lassoPoints.length} points`);

    this.isSelecting = true;
    this.selectionProgress = 'Selecting points...';
    this.updateViewportDimensions();

    // Capture the classifications before async operation
    const classification = this.selectedClassification;
    const sourceClassification = this.selectedSourceClassification;
    const polygon = [...this.lassoPoints];

    this.previewPolygon = polygon;

    setTimeout(async () => {
      if (!sourceClassification) {
        this.isLassoActive = false;
        this.lassoPoints = [];
        this.isSelecting = false;
        this.selectionProgress = '';
        this.previewPolygon = [];
        this.releaseLassoControls();
        return;
      }

      const selectedPoints = this.frustumCulledService.selectPointsInPolygon(
        polygon,
        this.viewWidth,
        this.viewHeight,
        { sampleRate: 1 }
      );

      const matchingPoints = this.frustumCulledService.filterPointsByClassification(
        selectedPoints,
        sourceClassification.value,
        sourceClassification.matchValues
      );

      if (matchingPoints.length > 0) {
        const color = new THREE.Color(classification.color);

        await this.frustumCulledService.showClassificationPreview(
          matchingPoints,
          color,
          classification.value
        );

        this.pendingClassification = {
          source: sourceClassification,
          target: classification,
          points: matchingPoints,
          polygon,
          previewCount: matchingPoints.length
        };

        this.selectionProgress = `${this.formatPointCount(matchingPoints.length)} points selected – review and apply.`;
      } else {
        this.frustumCulledService.clearClassificationPreview();
        this.snackBar.open('No points inside the lasso matched the source class.', 'OK', { duration: 2000 });
        this.selectionProgress = '';
        this.previewPolygon = [];
      }

      // Reset
      this.isLassoActive = false;
      this.lassoPoints = [];
      this.isSelecting = false;
      this.releaseLassoControls();
    }, 10);
  }

  private updateViewportDimensions(): void {
    if (!this.renderArea) {
      return;
    }
    const rect = this.renderArea.nativeElement.getBoundingClientRect();
    this.viewWidth = rect.width || window.innerWidth;
    this.viewHeight = rect.height || window.innerHeight;
  }

  private getPointerPosition(clientX: number, clientY: number): { x: number; y: number } {
    const rect = this.renderArea?.nativeElement.getBoundingClientRect();
    if (!rect) {
      return { x: clientX, y: clientY };
    }
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    return {
      x: Math.max(0, Math.min(rect.width, x)),
      y: Math.max(0, Math.min(rect.height, y))
    };
  }

  private isEventInsideRenderArea(event: MouseEvent): boolean {
    if (!this.renderArea) {
      return false;
    }
    return this.renderArea.nativeElement.contains(event.target as Node);
  }

  // ============================================================================
  // MEASUREMENT PERSISTENCE
  // ============================================================================

  private async loadMeasurementsFromBackend(pointCloudId: number): Promise<void> {
    if (!pointCloudId) return;

    try {
      console.log(`Loading measurements for point cloud ${pointCloudId}`);
      const measurements = await this.measurementService.getMeasurementsAsync(pointCloudId);

      console.log(`Loaded ${measurements.length} measurements from backend`);

      // Clear existing measurements
      this.savedMeasurements = [];
      this.frustumCulledService.clearMeasurements();

      // Add each measurement to the scene and local state
      for (const measurement of measurements) {
        const p1 = new THREE.Vector3(measurement.point1.x, measurement.point1.y, measurement.point1.z);
        const p2 = new THREE.Vector3(measurement.point2.x, measurement.point2.y, measurement.point2.z);

        // Add to local state
        this.savedMeasurements.push({
          id: measurement.id,
          points: [p1, p2],
          distance: measurement.distance,
          timestamp: new Date(measurement.createdAt || Date.now())
        });

        // Render in 3D
        await this.frustumCulledService.addMeasurementLine(p1, p2, measurement.id, measurement.distance);
      }

      // Update next ID to avoid conflicts
      if (measurements.length > 0) {
        const maxId = Math.max(...measurements.map(m => m.id));
        this.nextMeasurementId = maxId + 1;
      }

      if (measurements.length > 0) {
        console.log(`✅ Loaded and rendered ${measurements.length} measurements`);
      }

      // Update menu state
      this.menuService.updateMenuState({
        hasMeasurements: this.savedMeasurements.length > 0
      });
    } catch (error) {
      console.error('Failed to load measurements:', error);
      this.snackBar.open('Failed to load measurements', 'OK', { duration: 3000 });
    }
  }

  private async saveMeasurementToBackend(p1: THREE.Vector3, p2: THREE.Vector3, distance: number): Promise<void> {
    if (!this.activePointCloudId) return;

    try {
      const measurement = await this.measurementService.createMeasurementAsync(this.activePointCloudId, {
        point1: { x: p1.x, y: p1.y, z: p1.z },
        point2: { x: p2.x, y: p2.y, z: p2.z },
        distance
      });

      console.log(`Saved measurement ${measurement.id} to backend`);

      // Add to local state
      this.savedMeasurements.push({
        id: measurement.id,
        points: [p1.clone(), p2.clone()],
        distance: measurement.distance,
        timestamp: new Date(measurement.createdAt || Date.now())
      });

      // Render the measurement line in 3D
      await this.frustumCulledService.addMeasurementLine(p1, p2, measurement.id, measurement.distance);

      // Update menu state
      this.menuService.updateMenuState({
        hasMeasurements: this.savedMeasurements.length > 0
      });

      this.snackBar.open(`Measurement saved: ${distance.toFixed(2)} m`, 'OK', { duration: 3000 });
      console.log(`✅ Measurement ${measurement.id} rendered in 3D scene`);
    } catch (error) {
      console.error('Failed to save measurement:', error);
      this.snackBar.open('Failed to save measurement', 'OK', { duration: 3000 });
    }
  }
}

// Classification interface
interface Classification {
  id: number;
  value: number;
  name: string;
  color: string;
  defaultColor?: string;
  custom: boolean;
  pointCount: number;
  aliases?: string[];
  matchValues?: number[];
}

interface PendingClassification {
  source: Classification;
  target: Classification;
  points: SelectedPoint[];
  polygon: Array<{ x: number; y: number }>;
  previewCount: number;
}

interface ActivityLogEntry {
  id: number;
  timestamp: Date;
  type: 'classification' | 'measurement' | 'camera' | 'mode' | 'selection';
  icon: string;
  message: string;
  details?: string;
}

interface ClassificationSaveSummary {
  totalPoints: number;
  selectionMode: 'lasso' | 'brush' | 'box' | 'direct';
  targetClass: number;
  sourceClass: number | null;
  unstableIdentifiers: number;
}

interface ClassificationSaveQueueItem {
  pointCloudId: number;
  request: ClassificationEditRequest;
  summary: ClassificationSaveSummary;
  attempts: number;
}

interface ClassificationBatchStatus {
  operationId: string;
  status: 'queued' | 'processing' | 'completed' | 'failed';
  totalPoints: number;
  pointsProcessed: number;
  tilesTotal: number;
  tilesProcessed: number;
  unstableCount: number;
  receivedAt: string;
  updatedAt: string;
  completedAt: string | null;
  progressPercent: number;
}

interface DisplayPreferences {
  pointSize: number;
  pointBudget: number;
  backgroundColor: 'black' | 'white' | 'gray';
  edlEnabled: boolean;
  classificationColors: Record<number, string>;
}

interface PointInfoSnapshot {
  position: { x: number; y: number; z: number };
  classification?: number | null;
  color?: { r: number; g: number; b: number } | null;
  lat?: number | null;
  lng?: number | null;
  pointIndex?: number | null;
  intensity?: number | null;
  returnNumber?: number | null;
  timestamp: Date;
}
