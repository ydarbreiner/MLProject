import { Injectable, ElementRef, NgZone } from '@angular/core';
import { BehaviorSubject } from 'rxjs';
import * as THREE from 'three';
import { MapControls } from 'three/examples/jsm/controls/MapControls.js';

import { FrustumAwareCOPCSource } from './frustum-aware-copc-source';
import { ClassificationManager } from './classification-manager';
import type { ClassificationChangeSummary, SelectedPoint } from './classification-manager';
import { MeasurementVisualizer } from './measurement-visualizer';

export type { ClassificationChangeSummary, PointIdentifier, SelectedPoint } from './classification-manager';

export interface ClusterOverlayPatch {
  cluster: number;
  centroid: [number, number, number];
}

export interface PointPickResult {
  position: THREE.Vector3;
  classification?: number | null;
  color?: { r: number; g: number; b: number } | null;
  pointIndex?: number | null;
  intensity?: number | null;
  returnNumber?: number | null;
}

type CameraMode = 'orbit' | 'fps' | 'fly' | 'walk' | 'plan';

/**
 * Performance metrics for monitoring
 */
interface PerformanceMetrics {
  frameRate: number;
  chunksVisible: number;
  chunksCulled: number;
  frustumCullingEnabled: boolean;
  lastUpdate: Date;
}

/**
 * Frustum-Culled COPC Service
 * Implements frustum culling for COPC point clouds using Giro3D with minimal viable approach
 */
@Injectable({
  providedIn: 'root',
})
export class FrustumCulledCOPCService {
  private giro3dInstance: any;
  private pointCloudEntity: any;
  private controls: any;
  private frustumAwareCOPCSource: FrustumAwareCOPCSource | null = null;
  private isLoading = false;
  private pendingLoad: { url: string; name: string } | null = null;
  private readonly controlBaseline = {
    zoomSpeed: 1.5,
    panSpeed: 1.0,
    rotateSpeed: 0.35,
    enableDamping: true
  };
  private readonly controlEditing = {
    zoomSpeed: 3.2,
    panSpeed: 2.4,
    rotateSpeed: 0.65,
    enableDamping: false
  };
  private editingControlsActive = false;

  // State management
  private initialized = new BehaviorSubject<boolean>(false);
  public initialized$ = this.initialized.asObservable();

  // Performance monitoring
  private metrics: PerformanceMetrics = {
    frameRate: 0,
    chunksVisible: 0,
    chunksCulled: 0,
    frustumCullingEnabled: true,
    lastUpdate: new Date()
  };

  // Update throttling
  private updateThrottle = 100; // ms
  private lastUpdateTime = 0;

  private readonly measurementVisualizer = new MeasurementVisualizer({
    getScene: () => this.giro3dInstance?.scene ?? null,
    notifyChange: () => {
      if (this.giro3dInstance?.notifyChange) {
        this.giro3dInstance.notifyChange();
      }
    }
  });

  private readonly classificationManager = new ClassificationManager({
    getCamera: () => this.giro3dInstance?.view?.camera ?? null,
    getScene: () => this.giro3dInstance?.scene ?? null,
    getPointCloudEntity: () => this.pointCloudEntity ?? null,
    notifyChange: () => {
      if (this.giro3dInstance?.notifyChange) {
        this.giro3dInstance.notifyChange();
      }
    }
  });
  private customClassificationColors = new Map<number, THREE.Color>();
  private currentPointBudget = 2000000;
  private backgroundColor: 'black' | 'white' | 'gray' = 'black';
  private edlEnabled = false;

  // Revolutionary Camera System
  private cameraMode: CameraMode = 'orbit';
  private onPointerPivotToCursor?: (event: PointerEvent) => void;
  private pivotTarget: THREE.Vector3 | null = null;
  private fpsControls = {
    moveSpeed: 50,
    lookSpeed: 0.002,
    keys: { w: false, a: false, s: false, d: false, shift: false, space: false },
    velocity: { x: 0, y: 0, z: 0 },
    yaw: 0,
    pitch: 0,
    enabled: false
  };
  private fpsAnimationFrame: number | null = null;

  // Slice mode for seeing inside point cloud
  private sliceEnabled: boolean = false;
  private sliceHeight: number = 0;
  private sliceDirection: 'horizontal' | 'vertical' = 'horizontal';

  // Clip box mode for isolating areas
  private clipBoxEnabled: boolean = false;
  private clipBoxMin: THREE.Vector3 = new THREE.Vector3();
  private clipBoxMax: THREE.Vector3 = new THREE.Vector3();
  private clipBoxHelper: THREE.Box3Helper | null = null;

  // Concave hull visualization
  private hullEnabled: boolean = false;
  private hullVisualization: THREE.Object3D | null = null;
  private hullConcavity: number = 2.0; // Updated to match backend parameters (balanced approach)
  private hullColor: number = 0x00ff00;

  private poleMarkersGroup: THREE.Group | null = null;
  private poleMarkerObjects = new Map<string, {
    group: THREE.Group;
    mesh: THREE.Mesh;
    sprite: THREE.Sprite;
    texture?: THREE.Texture | null;
    baseSpriteScale: THREE.Vector3;
  }>();
  private pendingPoleMarkers: Array<{ id: string | number; name?: string | null; x: number; y: number; z: number | null }> | null = null;
  private lastPoleMarkers: Array<{ id: string | number; name?: string | null; x: number; y: number; z: number | null }> = [];
  private poleMarkerScale = 0.65;
  private poleLabelsVisible = true;
  private highlightedPoleId: string | null = null;
  private readonly poleMarkerDefaultColor = 0x2dd4bf;
  private readonly poleMarkerHighlightColor = 0xf97316;
  private readonly poleGroundSnapThreshold = 5;
  private readonly poleGroundSnapPadding = 50;

  // X-ray mode for classified points
  private xrayModeEnabled: boolean = false;

  // Classification visibility tracking
  private classificationVisibilityMap = new Map<number, boolean>();
  private clusterOverlayLayer: THREE.Points | null = null;
  private clusterColorCache = new Map<number, THREE.Color>();

  constructor(private ngZone: NgZone) {
    // Initialize all classifications as visible by default
    for (let i = 0; i < 256; i++) {
      this.classificationVisibilityMap.set(i, true);
    }
  }

  /**
   * Initialize Giro3D with frustum culling capabilities
   */
  initialize(renderArea: ElementRef<HTMLElement>): void {
    try {
      this.ngZone.runOutsideAngular(() => {
        console.log('Initializing Frustum-Culled COPC viewer...');
        this.initializeGiro3D(renderArea);
      });
    } catch (error) {
      console.error('Critical error in COPC initialization:', error);
      this.initialized.next(false);
    }
  }

  /**
   * Initialize Giro3D instance
   */
  private async initializeGiro3D(renderArea: ElementRef<HTMLElement>): Promise<void> {
    try {
      const container = renderArea.nativeElement;

      if (!container) {
        throw new Error('Render container not found');
      }

      // Completely clear container and ensure no existing contexts
      container.innerHTML = '';

      // Remove any existing canvas elements that might have contexts
      const existingCanvas = container.querySelector('canvas');
      if (existingCanvas) {
        existingCanvas.remove();
      }

      const uniqueId = `copc-view-${Date.now()}`;
      container.id = container.id || uniqueId;

      // Ensure container has proper CSS for WebGL
      container.style.position = 'relative';
      container.style.width = '100%';
      container.style.height = '100%';

      console.log('Container ready for COPC viewer with ID:', container.id);

      // Dynamic import of Giro3D
      const { default: Instance } = await import('@giro3d/giro3d/core/Instance');

      // Register the correct CRS for our point cloud (UTM Zone 13N)
      Instance.registerCRS(
        "EPSG:32613",
        "+proj=utm +zone=13 +datum=WGS84 +units=m +no_defs"
      );
      console.log('Registered EPSG:32613 (UTM Zone 13N) for point cloud CRS');

      // Create Giro3D instance with debug info
      console.log('Creating Giro3D instance with target:', container.id);
      console.log('Container dimensions:', {
        width: container.offsetWidth,
        height: container.offsetHeight,
        clientWidth: container.clientWidth,
        clientHeight: container.clientHeight
      });

      this.giro3dInstance = new Instance({
        target: container.id,
        crs: 'EPSG:32613', // Use UTM Zone 13N to match the point cloud
        backgroundColor: 'black',
        renderer: {
          logarithmicDepthBuffer: true,
        },
      });

      console.log('Giro3D instance created:', this.giro3dInstance);
      console.log('Giro3D renderer:', this.giro3dInstance.renderer);
      console.log('Giro3D domElement:', this.giro3dInstance.domElement);

      // Check canvas without creating additional WebGL contexts
      if (this.giro3dInstance.renderer?.domElement) {
        const canvas = this.giro3dInstance.renderer.domElement;
        console.log('Canvas dimensions:', {
          width: canvas.width,
          height: canvas.height,
          style: canvas.style.cssText
        });
        console.log('Giro3D renderer context type:', this.giro3dInstance.renderer.getContext()?.constructor.name);
      }

      // Enable Eye Dome Lighting
      this.giro3dInstance.renderingOptions.enableEDL = true;
      this.giro3dInstance.renderingOptions.EDLStrength = 3;

      console.log('Frustum-culled COPC viewer initialized!');

      // Set up camera controls for navigation
      this.setupCameraAndControls();

      // Set up frustum update monitoring immediately after instance creation
      this.setupFrustumUpdates();

      // Use Promise.resolve to properly queue the state change after current cycle
      Promise.resolve().then(() => {
        this.ngZone.run(() => {
          this.initialized.next(true);
        });
      });

    } catch (error) {
      console.error('Failed to initialize COPC viewer:', error);
      Promise.resolve().then(() => {
        this.ngZone.run(() => {
          this.initialized.next(false);
        });
      });
    }
  }

  /**
   * Load COPC point cloud with frustum culling
   */
  async loadPointCloud(url: string, name: string): Promise<void> {
    // Prevent multiple simultaneous loads
    if (this.isLoading) {
      const shouldQueue =
        this.pendingLoad === null ||
        this.pendingLoad.url !== url ||
        this.pendingLoad.name !== name;
      if (shouldQueue) {
        this.pendingLoad = { url, name };
        console.log('Point cloud load in progress, queuing next dataset:', url);
      } else {
        console.log('Point cloud load already queued for:', url);
      }
      return;
    }

    this.pendingLoad = null;
    if (this.pointCloudEntity) {
      console.log('Point cloud already loaded, cleaning up before new load');
      this.cleanupPointCloud();
    }

    this.isLoading = true;
    console.log('Loading COPC point cloud with frustum culling:', url);

    try {
      if (!this.giro3dInstance) {
        throw new Error('Giro3D instance not initialized');
      }

      console.log('Creating FrustumAwareCOPCSource for proper 206 streaming...');

      // Create FrustumAwareCOPCSource wrapper (this handles 206 partial content)
      this.frustumAwareCOPCSource = new FrustumAwareCOPCSource(url);
      console.log('FrustumAwareCOPCSource created');

      // Wait for initialization
      await this.frustumAwareCOPCSource.initialize();
      console.log('FrustumAwareCOPCSource initialized');

      // Create PointCloud entity using the wrapped source (handles all configuration)
      await this.createPointCloudEntity();

      // Wait for PointCloud to be ready (similar to tutorial's layer preprocessing)
      console.log('Waiting for PointCloud to be ready...');
      if (this.pointCloudEntity.isReady !== undefined) {
        console.log('PointCloud ready status:', this.pointCloudEntity.isReady);
      }

      // STEP 6: Position camera using entity bounds (OFFICIAL PATTERN)
      console.log('Positioning camera using entity bounding box...');
      try {
        // Use getBoundingBox() like the official example
        const volume = this.pointCloudEntity.getBoundingBox();
        console.log('Entity bounding box:', volume);

        if (volume) {
          const camera = this.giro3dInstance.view.camera;
          const THREE = await import('three');
          const center = volume.getCenter(new THREE.Vector3());

          // Official example pattern: camera above, looking down
          const lookAt = new THREE.Vector3(center.x, center.y, volume.min.z);
          camera.position.set(center.x, center.y - 1000, volume.max.z * 2);
          camera.lookAt(lookAt);

          console.log('Camera positioned using official pattern:', {
            center: { x: center.x, y: center.y, z: center.z },
            lookAt: { x: lookAt.x, y: lookAt.y, z: lookAt.z },
            cameraPosition: { x: camera.position.x, y: camera.position.y, z: camera.position.z }
          });
        }
      } catch (error) {
        console.warn('Could not get entity bounding box for camera positioning:', error);

        console.warn('Could not get entity bounding box, using default camera positioning');
      }

      // Force PointCloud to process the loaded data
      console.log('Forcing PointCloud to process COPC data...');

      // Try different methods to trigger geometry creation
      if (this.pointCloudEntity.update) {
        this.pointCloudEntity.update();
        console.log('Called pointCloudEntity.update()');
      }

      if (this.pointCloudEntity.preprocess) {
        await this.pointCloudEntity.preprocess();
        console.log('Called pointCloudEntity.preprocess()');
      }

      // Force Giro3D to update the scene
      this.giro3dInstance.notifyChange();
      console.log('Called giro3dInstance.notifyChange()');

      // Force a render
      if (this.giro3dInstance.render) {
        this.giro3dInstance.render();
        console.log('Called giro3dInstance.render()');
      }

      // Force Giro3D to update and render
      this.giro3dInstance.notifyChange();
      console.log('Called giro3dInstance.notifyChange()');

      if (this.giro3dInstance.render) {
        this.giro3dInstance.render();
        console.log('Called giro3dInstance.render()');
      }


      console.log('🎉 COPC point cloud loaded with frustum culling enabled!');

    } catch (error) {
      console.error('Failed to load COPC point cloud:', error);
      throw error;
    } finally {
      this.isLoading = false;
      const nextLoad = this.pendingLoad;
      this.pendingLoad = null;
      if (nextLoad) {
        // Fire the queued request on the next task to avoid deep recursion
        const { url, name } = nextLoad;
        void Promise.resolve().then(() => this.loadPointCloud(url, name));
      }
    }
  }

  /**
   * Position camera to view the point cloud properly
   */
  private async positionCameraForPointCloud(): Promise<void> {
    try {
      // Get COPC metadata for bounds
      const source = this.frustumAwareCOPCSource?.getGiro3DSource();
      if (source?.getMetadata) {
        const metadata = await source.getMetadata();
        if (metadata?.volume) {
          const volume = metadata.volume;
          const camera = this.giro3dInstance.view.camera;
          const THREE = await import('three');

          const center = volume.getCenter(new THREE.Vector3());
          const size = volume.getSize(new THREE.Vector3());
          const maxDim = Math.max(size.x, size.y, size.z);

          // Position camera at a good distance to see the entire point cloud
          camera.position.set(
            center.x + maxDim * 1.5,
            center.y - maxDim * 1.5,
            center.z + maxDim * 0.5
          );
          camera.lookAt(center);

          // Update controls
          if (this.controls) {
            this.controls.target.copy(center);
            this.controls.update();
          }

          console.log('Camera positioned for point cloud viewing:', {
            center: center,
            size: size,
            cameraPosition: camera.position
          });

          return;
        }
      }

      // Fallback positioning
      const camera = this.giro3dInstance.view.camera;
      camera.position.set(333400, 4351900 - 1000, 2200);
      camera.lookAt(333400, 4351900, 2100);
      console.log('Used fallback camera positioning');

    } catch (error) {
      console.error('Error positioning camera:', error);
    }
  }

  /**
   * Clean up existing point cloud entity before loading new one
   */
  private cleanupPointCloud(): void {
    console.log('Cleaning up existing point cloud entity');

    if (this.pointCloudEntity) {
      try {
        // Remove from Giro3D instance
        if (this.giro3dInstance && this.giro3dInstance.remove) {
          this.giro3dInstance.remove(this.pointCloudEntity);
        }

        // Dispose if method exists
        if (this.pointCloudEntity.dispose) {
          this.pointCloudEntity.dispose();
        }
      } catch (error) {
        console.warn('Error during point cloud cleanup:', error);
      }

      this.pointCloudEntity = null;
    }

    if (this.frustumAwareCOPCSource) {
      this.frustumAwareCOPCSource.dispose();
      this.frustumAwareCOPCSource = null;
    }

    // Clean up hull visualization
    this.cleanupHull();

    console.log('Point cloud cleanup completed');
  }

  /**
   * Create point cloud entity using Giro3D's PointCloud component
   */
  private async createPointCloudEntity(): Promise<void> {
    if (!this.frustumAwareCOPCSource) {
      throw new Error('FrustumAwareCOPCSource not initialized');
    }

    try {
      // Dynamic import of Giro3D's PointCloud
      const { default: PointCloud } = await import('@giro3d/giro3d/entities/PointCloud');
      console.log('PointCloud class imported:', PointCloud.name);

      // Create point cloud entity with the underlying Giro3D source
      this.pointCloudEntity = new PointCloud({
        source: this.frustumAwareCOPCSource.getGiro3DSource()
      });

      // Configure point cloud rendering parameters
      // Add to the scene
      await this.giro3dInstance.add(this.pointCloudEntity);
      console.log('Point cloud entity added to scene');
      console.log('Scene children count:', this.giro3dInstance.scene?.children?.length);

      // Configure PointCloud for rendering (CRITICAL for LOD triggering)
      this.pointCloudEntity.pointBudget = 2000000; // 2M points budget
      console.log('Point budget set to 2M points');
      this.pointCloudEntity.pointSize = 2.5;
      console.log('Point size set to 2.5px');

      // Set active attribute for coloring and configure elevation gradient
      try {
        this.pointCloudEntity.setActiveAttribute('Z');
        console.log('Active attribute set to Z for elevation coloring');

        // Try to set up color mapping for elevation
        this.setupElevationColorMapping();

      } catch (error) {
        console.log('Could not set Z attribute:', error);
      }

      // Configure EDL for better visibility
      this.giro3dInstance.renderingOptions.EDLStrength = 5;
      console.log('EDL strength set to 5');

      // Position camera to view the point cloud BEFORE triggering LOD
      await this.positionCameraForPointCloud();

      // Force update and render to trigger LOD
      this.giro3dInstance.notifyChange();
      if (this.giro3dInstance.render) {
        this.giro3dInstance.render();
      }

      console.log('Point cloud entity created and configured successfully');

      console.log('Point cloud entity created with frustum culling');
      this.applyPendingPoleMarkers();
    } catch (error) {
      console.error('Failed to create point cloud entity:', error);
      throw error;
    }
  }

  /**
   * Set up camera and controls
   */
  private setupCameraAndControls(): void {
    const camera = this.giro3dInstance.view.camera as THREE.PerspectiveCamera;

    // Fix camera clipping for close-up viewing
    camera.near = 0.1; // Allow viewing very close to geometry
    camera.far = 100000; // Keep far plane for large point clouds
    camera.updateProjectionMatrix();

    // Position camera for point cloud viewing
    camera.position.set(0, -1000, 500);
    camera.lookAt(0, 0, 0);

    // Set up map controls with better settings for close-up work
    this.controls = new MapControls(camera, this.giro3dInstance.domElement);
    this.controls.target.set(0, 0, 0);

    // Damping settings - make controls more responsive
    this.controls.enableDamping = this.controlBaseline.enableDamping;
    this.controls.dampingFactor = 0.22;

    // Distance constraints - allow getting very close
    this.controls.minDistance = 0.1; // Can get as close as 10cm
    this.controls.maxDistance = 50000; // Maximum zoom out distance

    // Zoom speed
    this.controls.zoomSpeed = this.controlBaseline.zoomSpeed;
    this.controls.panSpeed = this.controlBaseline.panSpeed;
    this.controls.rotateSpeed = this.controlBaseline.rotateSpeed;

    // Enable all movements
    this.controls.enableZoom = true;
    this.controls.enablePan = true;
    this.controls.enableRotate = true;
    this.controls.zoomToCursor = true;

    // Bind mouse buttons explicitly: pan (left), zoom (wheel/middle), rotate (right)
    this.controls.mouseButtons = {
      LEFT: THREE.MOUSE.PAN,
      MIDDLE: THREE.MOUSE.DOLLY,
      RIGHT: THREE.MOUSE.ROTATE
    };

    // Screen space panning for better ground-level control
    this.controls.screenSpacePanning = true;

    // Connect controls to Giro3D's view system
    this.giro3dInstance.view.setControls(this.controls);

    // Cursor-pivot rotate: only retarget when user right-clicks to rotate
    const pickPivot = (clientX: number, clientY: number) => {
      const hit = this.pickPointDetailed(clientX, clientY, { radiusPx: 6 });
      return hit?.position ?? null;
    };

    this.onPointerPivotToCursor = (event: PointerEvent) => {
      if (!this.controls) return;
      if (event.button !== 2) return; // only adjust pivot on right-click rotate

      const pivot = pickPivot(event.clientX, event.clientY);
      if (pivot) {
        this.pivotTarget = pivot.clone();
        // Nudge toward the pivot to start smoothing without a hard snap
        this.controls.target.lerp(pivot, 0.2);
        this.controls.update();
        this.giro3dInstance.notifyChange();
      }
    };
    this.giro3dInstance.domElement.addEventListener('pointerdown', this.onPointerPivotToCursor);

    // Add controls change listener with adaptive speed
    this.controls.addEventListener('change', () => {
      this.adjustControlSpeed();
      this.smoothPivotTarget();
      this.giro3dInstance.notifyChange();
    });

    console.log('Camera and controls configured for ground-level viewing');
  }

  /**
   * Adjust control speed based on camera distance to target
   */
  private adjustControlSpeed(): void {
    if (!this.controls || !this.giro3dInstance?.view?.camera) return;

    if (this.editingControlsActive) {
      this.controls.panSpeed = this.controlEditing.panSpeed;
      this.controls.rotateSpeed = this.controlEditing.rotateSpeed;
      return;
    }

    const camera = this.giro3dInstance.view.camera;
    const distance = camera.position.distanceTo(this.controls.target);

    // Adjust pan speed based on distance (slower when close, faster when far)
    // At 1m: panSpeed = 0.2, At 100m: panSpeed = 2.0, At 1000m: panSpeed = 5.0
    this.controls.panSpeed = Math.max(0.35, Math.min(5.0, distance * 0.002));

    // Adjust rotate speed slightly based on distance
    this.controls.rotateSpeed = Math.max(0.3, Math.min(1.5, 0.5 + distance * 0.0005));
  }

  /**
   * Gradually moves the control target toward a chosen pivot to avoid camera snaps.
   */
  private smoothPivotTarget(): void {
    if (!this.controls || !this.pivotTarget) return;

    const target = this.controls.target as THREE.Vector3;
    target.lerp(this.pivotTarget, 0.18);

    if (target.distanceTo(this.pivotTarget) < 0.05) {
      target.copy(this.pivotTarget);
      this.pivotTarget = null;
    }
  }

  /**
   * Fit camera to point cloud bounds for proper viewing
   */
  private async fitCameraToPointCloud(): Promise<void> {
    if (!this.pointCloudEntity || !this.giro3dInstance?.view?.camera) {
      return;
    }

    try {
      const THREE = await import('three');

      // Get point cloud bounding box
      let boundingBox = null;

      if (this.pointCloudEntity.boundingBox) {
        boundingBox = this.pointCloudEntity.boundingBox;
      } else if (this.pointCloudEntity.geometry && this.pointCloudEntity.geometry.boundingBox) {
        boundingBox = this.pointCloudEntity.geometry.boundingBox;
      }

      if (boundingBox) {
        const camera = this.giro3dInstance.view.camera;
        const center = boundingBox.getCenter(new THREE.Vector3());
        const size = boundingBox.getSize(new THREE.Vector3());

        // Position camera to view the entire point cloud
        const maxDim = Math.max(size.x, size.y, size.z);
        const distance = maxDim * 2; // Distance multiplier for good view

        camera.position.set(
          center.x + distance,
          center.y - distance,
          center.z + distance * 0.5
        );

        camera.lookAt(center);

        if (this.controls) {
          this.controls.target.copy(center);
          this.controls.update();
        }

        console.log('Camera fitted to point cloud bounds:', {
          center: center,
          size: size,
          cameraPosition: camera.position
        });
      } else {
        console.warn('Point cloud bounding box not available - using default camera position');
      }
    } catch (error) {
      console.error('Error fitting camera to point cloud:', error);
    }
  }

  /**
   * Set up frustum update monitoring
   */
  private setupFrustumUpdates(): void {
    console.log('Setting up frustum update monitoring...');

    // Ensure Giro3D instance exists before setting up event listeners
    if (!this.giro3dInstance) {
      console.error('Cannot setup frustum updates: Giro3D instance not initialized');
      return;
    }

    // Monitor camera changes for frustum updates using Giro3D's event system
    try {
      // Use Giro3D's view update events
      if (this.giro3dInstance.view) {
        this.giro3dInstance.view.addEventListener('camerachanged', () => {
          this.updateFrustum();
        });
        console.log('Frustum update monitoring active on camera changes');
      } else {
        console.warn('Giro3D view not available for event listeners');
      }
    } catch (error) {
      console.error('Failed to setup frustum update listener:', error);
    }
  }

  /**
   * Update the frustum for culling with throttling
   */
  private updateFrustum(): void {
    const now = Date.now();
    if (now - this.lastUpdateTime < this.updateThrottle) {
      return; // Throttle updates
    }

    if (this.frustumAwareCOPCSource && this.giro3dInstance?.view?.camera && this.pointCloudEntity) {
      // Update frustum for source
      this.frustumAwareCOPCSource.updateFrustum(this.giro3dInstance.view.camera);

      // Perform actual frustum culling on the point cloud entity
      this.performEntityLevelFrustumCulling().catch(err =>
        console.error('Async frustum culling error:', err)
      );

      this.updatePerformanceMetrics();
    }

    this.lastUpdateTime = now;
  }

  /**
   * Perform frustum culling at the PointCloud entity level
   */
  private async performEntityLevelFrustumCulling(): Promise<void> {
    if (!this.pointCloudEntity || !this.giro3dInstance?.view?.camera) {
      return;
    }

    try {
      const camera = this.giro3dInstance.view.camera;

      // Import THREE.js components
      const THREE = await import('three');

      // Create frustum from camera
      const frustum = new THREE.Frustum();
      const matrix = new THREE.Matrix4();
      matrix.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
      frustum.setFromProjectionMatrix(matrix);

      // Get point cloud children/chunks for culling
      if (this.pointCloudEntity.children && this.pointCloudEntity.children.length > 0) {
        let visibleChunks = 0;
        let culledChunks = 0;

        this.pointCloudEntity.children.forEach((child: any) => {
          if (child.geometry && child.geometry.boundingBox) {
            const bbox = child.geometry.boundingBox;

            if (frustum.intersectsBox(bbox)) {
              // Chunk is visible
              child.visible = true;
              visibleChunks++;
            } else {
              // Chunk is outside frustum - cull it
              child.visible = false;
              culledChunks++;
            }
          }
        });

        // Update metrics
        this.metrics.chunksVisible = visibleChunks;
        this.metrics.chunksCulled = culledChunks;

        if (visibleChunks > 0 || culledChunks > 0) {
          console.log(`Frustum culling: ${visibleChunks} visible, ${culledChunks} culled`);
        }
      } else {
        // Check if the main entity itself needs culling
        if (this.pointCloudEntity.geometry && this.pointCloudEntity.geometry.boundingBox) {
          const bbox = this.pointCloudEntity.geometry.boundingBox;
          this.pointCloudEntity.visible = frustum.intersectsBox(bbox);

          this.metrics.chunksVisible = this.pointCloudEntity.visible ? 1 : 0;
          this.metrics.chunksCulled = this.pointCloudEntity.visible ? 0 : 1;

          console.log(`Entity-level frustum culling: ${this.pointCloudEntity.visible ? 'visible' : 'culled'}`);
        }
      }
    } catch (error) {
      console.error('Error in entity-level frustum culling:', error);
    }
  }

  /**
   * Update performance metrics
   */
  private updatePerformanceMetrics(): void {
    if (this.frustumAwareCOPCSource) {
      const stats = this.frustumAwareCOPCSource.getStats();
      // Preserve chunksVisible and chunksCulled values set by frustum culling
      this.metrics.frameRate = 60; // Approximate, Giro3D handles timing
      this.metrics.frustumCullingEnabled = stats.frustumCullingEnabled;
      this.metrics.lastUpdate = new Date();
    }
  }

  /**
   * Get current performance metrics
   */
  getMetrics(): PerformanceMetrics {
    return { ...this.metrics };
  }

  /**
   * Export current view as image
   */
  exportImage(): void {
    if (this.giro3dInstance) {
      try {
        const canvas = this.giro3dInstance.domElement;
        const dataUrl = canvas.toDataURL('image/png');
        const link = document.createElement('a');
        link.download = 'copc-frustum-culled-export.png';
        link.href = dataUrl;
        link.click();
        console.log('Frustum-culled view exported');
      } catch (error) {
        console.error('Failed to export image:', error);
      }
   }
  }

  /**
   * Clean up resources
   */
  destroy(): void {
    if (this.giro3dInstance?.domElement && this.onPointerPivotToCursor) {
      this.giro3dInstance.domElement.removeEventListener('pointerdown', this.onPointerPivotToCursor);
    }
    this.onPointerPivotToCursor = undefined;
    this.pivotTarget = null;

    if (this.controls) {
      this.controls.dispose();
      this.controls = null;
    }

    this.classificationManager.dispose();
    this.clearPoleMarkers();

    if (this.giro3dInstance) {
      try {
        this.giro3dInstance.dispose?.();
      } catch (error) {
        console.warn('Error disposing Giro3D instance:', error);
      }
      this.giro3dInstance = null;
    }

    // Clean up frustum-aware source
    if (this.frustumAwareCOPCSource) {
      this.frustumAwareCOPCSource.dispose();
      this.frustumAwareCOPCSource = null;
    }

    this.pointCloudEntity = null;
    this.initialized.next(false);
    console.log('Frustum-culled COPC service destroyed');
  }



  /**
   * Apply materials to children with geometry
   */
  private async applyMaterialsToGeometry(): Promise<void> {
    const THREE = await import('three');
    const pointsMaterial = new THREE.PointsMaterial({
      size: 3.0,
      vertexColors: true,
      sizeAttenuation: true
    });

    this.pointCloudEntity.object3d.children.forEach((child: any, index: number) => {
      if (child.geometry) {
        child.material = pointsMaterial.clone();
        child.visible = true;
        console.log(`Applied material to child ${index} with geometry`);
      }
    });

    // Force render and fit camera
    if (this.giro3dInstance.render) {
      this.giro3dInstance.render();
    }
    this.fitCameraToPointCloud();
  }

  /**
   * Debug COPC source state when loading fails
   */
  private debugCOPCSourceState(): void {
    const source = this.frustumAwareCOPCSource?.getGiro3DSource();
    if (source) {
      console.log('COPC Source Debug Info:', {
        isReady: source.ready,
        ready: source.ready,
        url: (source as any).url || 'unknown',
        type: source.type,
        id: source.id,
        loading: source.loading,
        progress: source.progress,
        data: (source as any).data || 'not available',
        metadata: (source as any).metadata || 'not available'
      });

      // Check all available methods and properties
      console.log('COPC Source available methods:', Object.getOwnPropertyNames(source).filter(name => typeof (source as any)[name] === 'function'));
      console.log('COPC Source available properties:', Object.keys(source));
    }
  }

  /**
   * Debug scene structure when geometry isn't loading
   */
  private debugSceneStructure(): void {
    console.log('=== SCENE STRUCTURE DEBUG ===');

    if (this.giro3dInstance?.scene) {
      console.log('Scene children count:', this.giro3dInstance.scene.children.length);

      this.giro3dInstance.scene.children.forEach((child: any, index: number) => {
        console.log(`Scene child ${index}:`, {
          type: child.type,
          name: child.name,
          visible: child.visible,
          hasGeometry: !!child.geometry,
          hasChildren: !!child.children?.length
        });
      });
    }

    if (this.pointCloudEntity) {
      console.log('Point cloud entity final state:', {
        type: this.pointCloudEntity.type,
        visible: this.pointCloudEntity.visible,
        hasObject3d: !!this.pointCloudEntity.object3d,
        hasGeometry: !!this.pointCloudEntity.geometry,
        hasSource: !!this.pointCloudEntity.source
      });
    }

    console.log('=== END SCENE DEBUG ===');
  }

  /**
   * Wait for point cloud data to load and apply materials
   */
  private waitForPointCloudData(_material?: any): void {
    let attempts = 0;
    const maxAttempts = 20; // 10 seconds total

    const checkForData = () => {
      attempts++;

      if (this.pointCloudEntity?.object3d?.children?.length > 0) {
        console.log('Point cloud data loaded! Found', this.pointCloudEntity.object3d.children.length, 'children');
        this.pointCloudEntity.object3d.children.forEach((child: any, index: number) => {
          console.log(`Child ${index}:`, {
            type: child.type,
            geometry: child.geometry?.type,
            hasGeometry: !!child.geometry,
            visible: child.visible
          });
        });

        // Force render and fit camera
        if (this.giro3dInstance.render) {
          this.giro3dInstance.render();
        }
        this.fitCameraToPointCloud();

      } else if (attempts < maxAttempts) {
        console.log(`Waiting for point cloud data... attempt ${attempts}/${maxAttempts}`);
        setTimeout(checkForData, 500);
      } else {
        console.warn('Point cloud data did not load after', maxAttempts, 'attempts');

        // Try to force load by accessing the source
        const source = this.frustumAwareCOPCSource?.getGiro3DSource();
        if (source) {
          console.log('COPC source ready status:', source.ready);
          console.log('COPC source properties:', Object.keys(source));
        }
      }
    };

    // Start checking after initial delay
    setTimeout(checkForData, 1000);
  }

  /**
   * Add test geometry to verify Giro3D rendering works
   */
  private async addTestGeometry(): Promise<void> {
    try {
      const THREE = await import('three');

      // Create a simple red cube
      const geometry = new THREE.BoxGeometry(100, 100, 100);
      const material = new THREE.MeshBasicMaterial({ color: 0xff0000 });
      const cube = new THREE.Mesh(geometry, material);

      // Position the cube in view
      cube.position.set(0, 0, 100);

      // Add to Giro3D scene
      if (this.giro3dInstance?.scene) {
        this.giro3dInstance.scene.add(cube);
        console.log('TEST: Red cube added to scene for visibility verification');

        // Force render
        if (this.giro3dInstance.render) {
          this.giro3dInstance.render();
        }
      } else {
        console.error('TEST: Cannot add test cube - no scene available');
      }
    } catch (error) {
      console.error('TEST: Failed to add test geometry:', error);
    }
  }

  /**
   * Enable/disable frustum culling
   */
  setFrustumCullingEnabled(enabled: boolean): void {
    if (this.frustumAwareCOPCSource) {
      this.frustumAwareCOPCSource.setFrustumCullingEnabled(enabled);
      console.log(`Frustum culling: ${enabled ? 'enabled' : 'disabled'}`);
    }
  }

  /**
   * Set color scheme for point cloud visualization
   */
  setColorScheme(mode: 'rgb' | 'elevation' | 'classification' | 'cluster'): void {
    if (!this.pointCloudEntity) {
      console.warn('Cannot set color scheme: point cloud not loaded');
      return;
    }

    try {
      console.log(`Setting color scheme to: ${mode}`);

      switch (mode) {
        case 'rgb':
          this.pointCloudEntity.setActiveAttribute('Color');
          // Reset any color map for natural RGB colors
          if (this.pointCloudEntity.colorMap) {
            this.pointCloudEntity.colorMap.reset?.();
          }
          this.pointCloudEntity.colorMap = null as any;
          break;
        case 'elevation':
          this.pointCloudEntity.setActiveAttribute('Z');
          // Configure elevation gradient from blue (low) to red (high)
          this.configureElevationGradient();
          break;
        case 'classification':
          this.pointCloudEntity.setActiveAttribute('Classification');
          // Configure discrete classification colors
          this.configureClassificationColors();
          break;
        case 'cluster':
          this.pointCloudEntity.setActiveAttribute('UserData');
          // Configure discrete cluster colors
          this.configureClusterColors();
          break;
      }

      this.giro3dInstance.notifyChange();
      console.log(`Color scheme set to: ${mode}`);
    } catch (error) {
      console.error('Failed to set color scheme:', error);
    }
  }

  private async setupElevationColorMapping(): Promise<void> {
    try {
      console.log('Setting up elevation color mapping using Giro3D ColorMap API...');

      // Get the source to access metadata
      const source = this.frustumAwareCOPCSource?.getGiro3DSource();
      if (!source) {
        console.warn('COPC source not available for metadata');
        return;
      }

      // Dynamically get the bounding box from the metadata
      const metadata = await source.getMetadata();
      const bounds = metadata?.volume;

      if (!bounds) {
          console.error('Could not get bounds from point cloud metadata.');
          return;
      }

      // Use the actual min/max Z values from the point cloud
      const minElevation = bounds.min.z;
      const maxElevation = bounds.max.z;
      
      console.log(`Dynamic elevation range detected: ${minElevation} to ${maxElevation}`);


      // Import Giro3D color mapping components
      const { default: ColorMap } = await import('@giro3d/giro3d/core/ColorMap');
      const { ColorMapMode } = await import('@giro3d/giro3d/core/ColorMap');

      // Create elevation color ramp array (blue -> green -> red)
      const elevationColors = [
        [0, 0, 255],      // Blue (low elevation)
        [0, 128, 255],    // Light blue
        [0, 255, 255],    // Cyan
        [0, 255, 128],    // Light green
        [0, 255, 0],      // Green (medium elevation)
        [128, 255, 0],    // Yellow-green
        [255, 255, 0],    // Yellow
        [255, 128, 0],    // Orange
        [255, 0, 0]       // Red (high elevation)
      ];
      
      const colorsAsColorObjects = elevationColors.map(
        color => new THREE.Color(color[0] / 255, color[1] / 255, color[2] / 255)
      );

      // Create ColorMap with the DYNAMIC range
      const elevationColorMap = new ColorMap({
        colors: colorsAsColorObjects,
        min: minElevation,
        max: maxElevation,
        mode: ColorMapMode.Elevation
      });

      // Assign to point cloud entity
      this.pointCloudEntity.colorMap = elevationColorMap;
      console.log('✓ Elevation ColorMap created and assigned with range:', minElevation, 'to', maxElevation);

      // Ensure the color map is active
      elevationColorMap.active = true;
      console.log('✓ ColorMap activated');

      // Force update
      this.giro3dInstance.notifyChange();

    } catch (importError) {
      console.warn('Could not import ColorMap or ColorMapMode, trying alternative approach:', importError);
      this.setupMaterialBasedElevationColoring();
    }
  }

  // Classification color overrides (custom LUT)
  setClassificationColors(palette: Record<number, string>): void {
    this.customClassificationColors.clear();
    Object.entries(palette).forEach(([idString, hex]) => {
      const id = Number(idString);
      if (Number.isNaN(id)) {
        return;
      }
      try {
        const color = new THREE.Color(hex);
        this.customClassificationColors.set(id, color);
      } catch (error) {
        console.warn(`Invalid color for classification ${id}:`, hex);
      }
    });

    this.refreshClassificationColorLUT();
  }

  /**
   * Force reapplication of the current classification LUT (used when colors change)
   */
  refreshClassificationColorLUT(): void {
    if (!this.pointCloudEntity || !this.customClassificationColors.size) {
      return;
    }

    this.applyClassificationColorLUT();
    try {
      this.pointCloudEntity.setActiveAttribute('Classification');
    } catch (error) {
      console.warn('Failed to set Classification attribute after applying custom colors', error);
    }
    this.giro3dInstance?.notifyChange?.();
    this.giro3dInstance?.render?.();
  }

  private async applyClassificationColorLUT(): Promise<void> {
    if (!this.pointCloudEntity || !this.customClassificationColors.size) {
      return;
    }

    try {
      const { default: ColorMap, ColorMapMode } = await import('@giro3d/giro3d/core/ColorMap');

      // Build 256-color LUT (same as cluster colors)
      const lut: THREE.Color[] = [];
      for (let i = 0; i < 256; i++) {
        const customColor = this.customClassificationColors.get(i);
        lut.push(customColor ? customColor.clone() : new THREE.Color(0.5, 0.5, 0.5));
      }

      const colorMap = new ColorMap({
        colors: lut,
        min: 0,
        max: 255,
        mode: (ColorMapMode as any).Discrete ?? ColorMapMode.Elevation
      });

      // ✅ FIX 1: Bind ColorMap to Classification attribute
      (colorMap as any).attribute = 'Classification';

      // ✅ FIX 2: Mark ColorMap as needing update
      (colorMap as any).needsUpdate = true;

      colorMap.active = true;

      // ✅ FIX 3: Assign to point cloud entity
      this.pointCloudEntity.colorMap = colorMap;

      // ✅ FIX 4: Bind to material (if accessible)
      if (this.pointCloudEntity.object3d) {
        this.pointCloudEntity.object3d.traverse((node: any) => {
          if (node.isMesh || node.isPoints) {
            const material = node.material;
            if (material) {
              material.colorMap = colorMap;
              material.vertexColors = false; // Disable vertex colors, use ColorMap
              material.needsUpdate = true;
            }
          }
        });
      }

      // ✅ FIX 5: Force attribute consistency
      this.pointCloudEntity.setActiveAttribute('Classification');

      this.giro3dInstance?.notifyChange?.();
      this.giro3dInstance?.render?.();
      console.log(`✅ Applied classification ColorMap (${this.customClassificationColors.size} entries)`);
    } catch (error) {
      console.error('Failed to apply classification color LUT', error);
    }
  }

  /**
   * ✅ FIX 6: Handle late-loaded tiles
   * Setup observer to reapply classification ColorMap when new tiles are loaded
   */
  private setupClassificationColorObserver(): void {
    if (!this.pointCloudEntity) return;

    // Reapply ColorMap when new tiles are loaded
    // This ensures late-loaded geometry also gets the custom colors
    this.pointCloudEntity.addEventListener('tile-loaded', () => {
      if (this.customClassificationColors.size > 0) {
        this.applyClassificationColorLUT();
      }
    });

    console.log('✅ Classification color observer setup complete');
  }

  /**
   * Setup material-based elevation coloring as fallback
   */
  private async setupMaterialBasedElevationColoring(): Promise<void> {
    try {
      console.log('Setting up material-based elevation coloring...');

      const THREE = await import('three');

      // Create custom shader material for elevation coloring
      const elevationVertexShader = `
        attribute float z;
        varying vec3 vColor;
        varying float vZ;

        void main() {
          vZ = position.z;

          // Map Z coordinate to color gradient
          float normalizedZ = (position.z - 2000.0) / 300.0; // Adjust based on your data range
          normalizedZ = clamp(normalizedZ, 0.0, 1.0);

          if (normalizedZ < 0.5) {
            // Blue to Green
            vColor = mix(vec3(0.0, 0.0, 1.0), vec3(0.0, 1.0, 0.0), normalizedZ * 2.0);
          } else {
            // Green to Red
            vColor = mix(vec3(0.0, 1.0, 0.0), vec3(1.0, 0.0, 0.0), (normalizedZ - 0.5) * 2.0);
          }

          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = 3.0;
        }
      `;

      const elevationFragmentShader = `
        varying vec3 vColor;

        void main() {
          gl_FragColor = vec4(vColor, 1.0);
        }
      `;

      // Create shader material
      const elevationMaterial = new THREE.ShaderMaterial({
        vertexShader: elevationVertexShader,
        fragmentShader: elevationFragmentShader,
        transparent: false
      });

      // Apply to point cloud
      if (this.pointCloudEntity.object3d) {
        this.pointCloudEntity.object3d.traverse((child: any) => {
          if (child.isPoints || child.material) {
            child.material = elevationMaterial;
            console.log('✓ Elevation shader material applied to child object');
          }
        });
      }

      // Force render update
      this.giro3dInstance.notifyChange();
      console.log('✓ Material-based elevation coloring setup complete');

    } catch (error) {
      console.error('Failed to setup material-based elevation coloring:', error);

      // Final fallback - just try the standard gradient configuration
      setTimeout(() => {
        this.configureElevationGradient();
      }, 1000);
    }
  }

  /**
   * Configure initial elevation gradient when point cloud loads
   */
  private configureInitialElevationGradient(): void {
    console.log('Configuring initial elevation gradient...');
    this.configureElevationGradient();
  }

  /**
   * Configure elevation gradient from blue (low) to red (high)
   */
  private async configureElevationGradient(): Promise<void> {
    try {
      console.log('Configuring elevation gradient using Giro3D ColorMap API...');

      // If no colorMap exists, create one
      if (!this.pointCloudEntity.colorMap) {
        console.log('No colorMap found, creating new one...');
        await this.setupElevationColorMapping();
        return;
      }
      
      // Get the source to access metadata
      const source = this.frustumAwareCOPCSource?.getGiro3DSource();
      if (!source) {
          console.warn('COPC source not available for metadata');
          return;
      }

      // Dynamically get the bounding box from the metadata
      const metadata = await source.getMetadata();
      const bounds = metadata?.volume;

      if (!bounds) {
          console.error('Could not get bounds from point cloud metadata.');
          return;
      }
      
      // Use the actual min/max Z values from the point cloud
      const minElevation = bounds.min.z;
      const maxElevation = bounds.max.z;

      // Update existing colorMap with elevation colors
      const colorMap = this.pointCloudEntity.colorMap;
      console.log('Found existing ColorMap:', colorMap);

      // Create elevation color ramp
      const elevationColors = [
        [0, 0, 255],      // Blue (low elevation)
        [0, 128, 255],    // Light blue
        [0, 255, 255],    // Cyan
        [0, 255, 128],    // Light green
        [0, 255, 0],      // Green (medium elevation)
        [128, 255, 0],    // Yellow-green
        [255, 255, 0],    // Yellow
        [255, 128, 0],    // Orange
        [255, 0, 0]       // Red (high elevation)
      ];

      colorMap.colors = elevationColors.map(
        color => new THREE.Color(color[0] / 255, color[1] / 255, color[2] / 255)
      );
      console.log('✓ Updated ColorMap colors');

      // Set elevation range using dynamic values
      colorMap.min = minElevation;
      colorMap.max = maxElevation;
      console.log(`✓ Set elevation range: ${minElevation}m to ${maxElevation}m`);

      // Import and set mode to Elevation
      try {
        const { ColorMapMode } = await import('@giro3d/giro3d/core/ColorMap');
        colorMap.mode = ColorMapMode.Elevation;
        console.log('✓ Set ColorMap mode to Elevation');
      } catch (importError) {
        console.warn('Could not import ColorMapMode:', importError);
      }

      // Ensure the color map is active
      colorMap.active = true;
      console.log('✓ ColorMap activated');

      // Force update
      this.giro3dInstance.notifyChange();

    } catch (error) {
      console.error('Failed to configure elevation gradient:', error);
      if (error instanceof Error) {
        console.error('Error details:', error.stack);
      } else {
        console.error('An unknown error occurred:', error);
      }
    }
  }

  /**
   * Configure discrete colors for classification mode
   *
   * NOTE: Giro3D handles classification colors automatically when the active
   * attribute is set to 'Classification'. The point cloud data contains
   * classification values and Giro3D applies standard ASPRS colors.
   */
  private configureClassificationColors(): void {
    // If no custom palette, use Giro3D defaults
    if (!this.customClassificationColors.size) {
      console.log('✅ Classification colors handled automatically by Giro3D');
      // Still setup observer for when custom colors are applied later
      this.setupClassificationColorObserver();
      return;
    }
    // Apply a custom LUT for classification
    this.applyClassificationColorLUT();
    // Setup observer to handle late-loaded tiles
    this.setupClassificationColorObserver();
  }

  /**
   * Configure discrete colors for cluster mode
   * Uses UserData dimension which contains cluster IDs (0-255)
   */
  private async configureClusterColors(): Promise<void> {
    console.log('🎨 Configuring cluster colors from UserData dimension');

    if (!this.pointCloudEntity?.colorMap) {
      console.warn('ColorMap not available for cluster configuration');
      return;
    }

    try {
      const colorMap = this.pointCloudEntity.colorMap;

      // Create a full 256-color lookup table (UserData is uint8: 0-255)
      // This ensures each discrete value maps to its own specific color
      const lut: THREE.Color[] = [];

      // Generate 12 distinct colors for clusters 0-11
      const clusterPalette: THREE.Color[] = [];
      for (let i = 0; i < 12; i++) {
        const hue = (i * 137.5) % 360; // Golden angle for even distribution
        const saturation = 0.85;
        const lightness = 0.55;

        const rgb = this.hslToRgb(hue / 360, saturation, lightness);
        clusterPalette.push(new THREE.Color(rgb[0], rgb[1], rgb[2]));
      }

      console.log('Generated cluster colors:', clusterPalette.map(c => '#' + c.getHexString()));

      // Build full 256-color LUT
      for (let i = 0; i < 256; i++) {
        if (i < 12) {
          // Clusters 0-11: use distinct colors
          lut.push(clusterPalette[i]);
        } else if (i === 255) {
          // Unassigned points: gray
          lut.push(new THREE.Color(0.4, 0.4, 0.4));
        } else {
          // Other values (12-254): also gray (shouldn't appear in our data)
          lut.push(new THREE.Color(0.4, 0.4, 0.4));
        }
      }

      // Set the full 256-color array
      colorMap.colors = lut;
      console.log('✓ Set ColorMap with 256-color LUT');

      // Set value range to cover full uint8 range
      colorMap.min = 0;
      colorMap.max = 255;
      console.log('✓ Set value range: 0 to 255');

      // Try to use Discrete mode if available, otherwise use Elevation mode
      try {
        const { ColorMapMode } = await import('@giro3d/giro3d/core/ColorMap');
        // Try Discrete mode first, fall back to Elevation
        if ((ColorMapMode as any).Discrete !== undefined) {
          colorMap.mode = (ColorMapMode as any).Discrete;
          console.log('✓ Set ColorMap mode to Discrete');
        } else {
          colorMap.mode = ColorMapMode.Elevation;
          console.log('✓ Set ColorMap mode to Elevation (with 256 discrete colors)');
        }
      } catch (importError) {
        console.warn('Could not import ColorMapMode:', importError);
      }

      // Activate the color map
      colorMap.active = true;
      console.log('✓ ColorMap activated for clusters');

      this.giro3dInstance.notifyChange();
      console.log('✅ Cluster colors configured with 256-color LUT');
    } catch (error) {
      console.error('Failed to configure cluster colors:', error);
      if (error instanceof Error) {
        console.error('Error details:', error.stack);
      }
    }
  }

  /**
   * Convert HSL to RGB (helper for cluster colors)
   */
  private hslToRgb(h: number, s: number, l: number): [number, number, number] {
    let r, g, b;

    if (s === 0) {
      r = g = b = l;
    } else {
      const hue2rgb = (p: number, q: number, t: number) => {
        if (t < 0) t += 1;
        if (t > 1) t -= 1;
        if (t < 1/6) return p + (q - p) * 6 * t;
        if (t < 1/2) return q;
        if (t < 2/3) return p + (q - p) * (2/3 - t) * 6;
        return p;
      };

      const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
      const p = 2 * l - q;
      r = hue2rgb(p, q, h + 1/3);
      g = hue2rgb(p, q, h);
      b = hue2rgb(p, q, h - 1/3);
    }

    return [r, g, b];
  }

  /**
   * Get Giro3D's classification array for visibility control
   */
  getClassifications(): any[] {
    if (!this.pointCloudEntity) {
      console.warn('Cannot get classifications: point cloud not loaded');
      return [];
    }

    try {
      return this.pointCloudEntity.classifications || [];
    } catch (error) {
      console.error('Error getting classifications:', error);
      return [];
    }
  }

  /**
   * Set visibility for a specific classification value
   * This uses Giro3D's shader-based visibility system for real-time GPU filtering
   */
  setClassificationVisibility(classificationValue: number, visible: boolean): void {
    if (!this.pointCloudEntity) {
      console.warn('Cannot set classification visibility: point cloud not loaded');
      return;
    }

    try {
      const classifications = this.getClassifications();

      if (classificationValue >= 0 && classificationValue < classifications.length) {
        // Update Giro3D's classification array (affects shader)
        classifications[classificationValue].visible = visible;

        // Track in our local map
        this.classificationVisibilityMap.set(classificationValue, visible);

        // Update the selection filter so lasso/brush only select visible classifications
        this.updateClassificationSelectionFilter();

        // Trigger re-render
        this.giro3dInstance.notifyChange();

        console.log(`Classification ${classificationValue} visibility set to: ${visible}`);
      } else {
        console.warn(`Invalid classification value: ${classificationValue} (must be 0-${classifications.length - 1})`);
      }
    } catch (error) {
      console.error('Error setting classification visibility:', error);
    }
  }

  /**
   * Get visibility state for a specific classification
   */
  getClassificationVisibility(classificationValue: number): boolean {
    return this.classificationVisibilityMap.get(classificationValue) ?? true;
  }

  /**
   * Get all visible classification values as a Set
   * Used by selection tools to filter points
   */
  getVisibleClassifications(): Set<number> {
    const visibleSet = new Set<number>();

    this.classificationVisibilityMap.forEach((visible, classValue) => {
      if (visible) {
        visibleSet.add(classValue);
      }
    });

    return visibleSet;
  }

  /**
   * Set visibility for multiple classifications at once
   */
  setMultipleClassificationVisibility(visibilityMap: Map<number, boolean>): void {
    visibilityMap.forEach((visible, classValue) => {
      this.setClassificationVisibility(classValue, visible);
    });
  }

  /**
   * Show all classifications
   */
  showAllClassifications(): void {
    const classifications = this.getClassifications();

    for (let i = 0; i < classifications.length; i++) {
      this.setClassificationVisibility(i, true);
    }

    console.log('All classifications shown');
  }

  /**
   * Hide all classifications
   */
  hideAllClassifications(): void {
    const classifications = this.getClassifications();

    for (let i = 0; i < classifications.length; i++) {
      this.setClassificationVisibility(i, false);
    }

    console.log('All classifications hidden');
  }

  /**
   * Reset classification visibility to defaults (all visible)
   */
  resetClassificationVisibility(): void {
    this.showAllClassifications();
  }

  /**
   * Update the classification manager's visibility filter
   * This ensures selection tools only select points from visible classifications
   */
  updateClassificationSelectionFilter(): void {
    const visibleSet = this.getVisibleClassifications();
    this.classificationManager.setVisibleClassificationsFilter(visibleSet);
  }

  /**
   * Set point size for rendering
   */
  setPointSize(size: number): void {
    if (!this.pointCloudEntity) {
      console.warn('Cannot set point size: point cloud not loaded');
      return;
    }

    try {
      if (this.pointCloudEntity.object3d) {
        this.pointCloudEntity.object3d.traverse((child: any) => {
          if (child.material && child.material.size !== undefined) {
            child.material.size = size;
            child.material.needsUpdate = true;
          }
        });
      }
      this.giro3dInstance.notifyChange();
      console.log(`Point size set to: ${size}`);
    } catch (error) {
      console.error('Failed to set point size:', error);
    }
  }

  /**
   * Reset camera view to fit the point cloud
   */
  resetView(): void {
    if (!this.pointCloudEntity || !this.giro3dInstance?.view?.camera) {
      console.warn('Cannot reset view: point cloud or camera not available');
      return;
    }

    try {
      this.fitCameraToPointCloud();
      console.log('View reset to fit point cloud');
    } catch (error) {
      console.error('Failed to reset view:', error);
    }
  }


  /**
   * Enable/disable debug mode
   */
  setDebugMode(enabled: boolean): void {
    if (this.frustumAwareCOPCSource) {
      this.frustumAwareCOPCSource.setDebugMode(enabled);
      console.log(`Debug mode: ${enabled ? 'enabled' : 'disabled'}`);
    }
  }

  // ============================================================================
  // MEASUREMENT & CLASSIFICATION DELEGATES
  // ============================================================================

  async addMeasurementLine(
    point1: THREE.Vector3,
    point2: THREE.Vector3,
    id: number,
    distance?: number
  ): Promise<void> {
    await this.measurementVisualizer.addMeasurementLine(point1, point2, id, distance);
  }

  removeMeasurementLine(id: number): void {
    this.measurementVisualizer.removeMeasurementLine(id);
  }

  clearMeasurements(): void {
    this.measurementVisualizer.clearMeasurements();
  }

  setSelectedMeasurement(id: number | null): void {
    this.measurementVisualizer.setSelectedMeasurement(id);
  }

  showMeasurementPreview(point: THREE.Vector3): void {
    this.measurementVisualizer.showPreviewLine(point);
  }

  updateMeasurementPreview(point1: THREE.Vector3, point2: THREE.Vector3): void {
    this.measurementVisualizer.updatePreviewLine(point1, point2);
  }

  hideMeasurementPreview(): void {
    this.measurementVisualizer.hidePreviewLine();
  }

  async updateSelectionPreview(
    position: THREE.Vector3,
    radius: number,
    color: THREE.Color,
    visible: boolean
  ): Promise<void> {
    await this.classificationManager.updateSelectionPreview(position, radius, color, visible);
  }

  hideSelectionPreview(): void {
    this.classificationManager.hideSelectionPreview();
  }

  async updatePointClassification(
    points: SelectedPoint[],
    classificationValue: number,
    color: THREE.Color,
    sourceClassification?: number | number[] | null
  ): Promise<ClassificationChangeSummary> {
    return this.classificationManager.updatePointClassification(
      points,
      classificationValue,
      color,
      sourceClassification
    );
  }

  async addClassifiedPoints(
    points: THREE.Vector3[],
    color: THREE.Color,
    _classificationId: number
  ): Promise<void> {
    await this.classificationManager.addClassifiedPoints(points, color);
  }

  clearClassificationOverlay(): void {
    this.classificationManager.clearClassificationOverlay();
  }

  clearClassificationOverrides(): void {
    this.classificationManager.clearClassificationOverrides();
  }

  setClassificationOverrides(
    overrides: Record<string, Record<string, number>>,
    palette: Map<number, THREE.Color>,
    append: boolean = false
  ): void {
    this.classificationManager.setClassificationOverrides(overrides, palette, append);
  }

  applyClusterClassificationOverlay(
    overrides: Record<string, Record<string, number>>,
    palette: Map<number, THREE.Color>
  ): void {
    this.classificationManager.applyClusterOverrides(overrides, palette);
  }

  clearClusterClassificationOverlay(): void {
    this.classificationManager.clearClusterOverrides();
  }

  processClassificationOverrides(): number {
    return this.classificationManager.applyPendingOverrides();
  }

  async showClassificationPreview(
    points: SelectedPoint[],
    color: THREE.Color,
    classificationValue: number
  ): Promise<void> {
    await this.classificationManager.showClassificationPreview(points, color, classificationValue);
  }

  clearClassificationPreview(): void {
    this.classificationManager.clearClassificationPreview();
  }

  getClassifiedPointCount(): number {
    return this.classificationManager.getClassifiedPointCount();
  }

  undo(): ClassificationChangeSummary | null {
    return this.classificationManager.undo();
  }

  redo(): ClassificationChangeSummary | null {
    return this.classificationManager.redo();
  }

  canUndo(): boolean {
    return this.classificationManager.canUndo();
  }

  canRedo(): boolean {
    return this.classificationManager.canRedo();
  }

  clearHistory(): void {
    this.classificationManager.clearHistory();
  }

  selectPointsInBrush(
    screenX: number,
    screenY: number,
    brushSize: number,
    depthPenetration: number
  ): SelectedPoint[] {
    return this.classificationManager.selectPointsInBrush(
      screenX,
      screenY,
      brushSize,
      depthPenetration
    );
  }

  selectPointsInBox(
    minX: number,
    minY: number,
    maxX: number,
    maxY: number,
    screenWidth: number,
    screenHeight: number
  ): SelectedPoint[] {
    return this.classificationManager.selectPointsInBox(
      minX,
      minY,
      maxX,
      maxY,
      screenWidth,
      screenHeight
    );
  }

  selectPointsInPolygon(
    polygonPoints: Array<{ x: number; y: number }>,
    screenWidth: number,
    screenHeight: number,
    options?: { sampleRate?: number }
  ): SelectedPoint[] {
    return this.classificationManager.selectPointsInPolygon(
      polygonPoints,
      screenWidth,
      screenHeight,
      options
    );
  }

  filterPointsByClassification(
    points: SelectedPoint[],
    classificationId: number | null | undefined,
    matchValues?: number[]
  ): SelectedPoint[] {
    return this.classificationManager.filterPointsByClassification(points, classificationId, matchValues);
  }

  getCamera(): THREE.Camera | null {
    return this.giro3dInstance?.view?.camera ?? null;
  }

  getPointCloudEntity(): any {
    return this.pointCloudEntity ?? null;
  }

  setCameraControlsEnabled(enabled: boolean): void {
    if (this.controls) {
      this.controls.enabled = enabled;
    }
  }

  zoomIn(): void {
    this.adjustZoom(0.85);
  }

  zoomOut(): void {
    this.adjustZoom(1.2);
  }

  private adjustZoom(multiplier: number): void {
    if (!this.controls || !this.giro3dInstance?.view?.camera) {
      return;
    }

    const camera = this.giro3dInstance.view.camera as THREE.PerspectiveCamera;

    if (typeof (this.controls as any).dollyIn === 'function') {
      if (multiplier < 1) {
        (this.controls as any).dollyIn(1 / multiplier);
      } else {
        (this.controls as any).dollyOut(multiplier);
      }
    } else if (camera.isPerspectiveCamera) {
      camera.position.addScaledVector(camera.getWorldDirection(new THREE.Vector3()), multiplier < 1 ? -10 : 10);
    }

    this.controls.update?.();
    this.giro3dInstance?.notifyChange?.();
  }

  adjustCameraHeight(deltaZ: number): void {
    const camera = this.getCamera();
    if (!camera) return;

    camera.position.z += deltaZ;
    if (this.controls) {
      this.controls.target.z += deltaZ;
      this.controls.update();
    }
    this.giro3dInstance?.notifyChange?.();
  }

  getPointCloudHeightRange(): Promise<{ min: number; max: number } | null> {
    return new Promise(resolve => {
      if (!this.pointCloudEntity?.boundingBox) {
        resolve(null);
        return;
      }

      const min = this.pointCloudEntity.boundingBox.min.z;
      const max = this.pointCloudEntity.boundingBox.max.z;
      resolve({ min, max });
    });
  }

  enableSliceMode(height: number, direction: 'horizontal' | 'vertical' = 'horizontal'): void {
    this.sliceEnabled = true;
    this.sliceHeight = height;
    this.sliceDirection = direction;
    this.applySliceFilter();
  }

  disableSliceMode(): void {
    this.sliceEnabled = false;
    this.applySliceFilter();
  }

  updateSliceHeight(height: number): void {
    this.sliceHeight = height;
    if (this.sliceEnabled) {
      this.applySliceFilter();
    }
  }

  private applySliceFilter(): void {
    if (!this.pointCloudEntity?.object3d) {
      return;
    }

    const isHorizontal = this.sliceDirection === 'horizontal';
    const lower = this.sliceHeight - 5;
    const upper = this.sliceHeight + 5;

    this.pointCloudEntity.object3d.traverse((child: any) => {
      if (!child.isPoints || !child.geometry?.boundingBox) {
        return;
      }

      if (!this.sliceEnabled) {
        child.visible = true;
        return;
      }

      const bbox = child.geometry.boundingBox.clone().applyMatrix4(child.matrixWorld);
      if (isHorizontal) {
        child.visible = bbox.min.z <= upper && bbox.max.z >= lower;
      } else {
        child.visible = Math.abs(bbox.getCenter(new THREE.Vector3()).x - this.sliceHeight) < (bbox.getSize(new THREE.Vector3()).x * 0.5 + 5);
      }
    });

    this.giro3dInstance?.notifyChange?.();
  }

  setClipBoxFromView(radius: number = 200): void {
    const camera = this.giro3dInstance?.view?.camera;
    if (!camera) return;

    const center = this.controls ? this.controls.target.clone() : camera.position.clone();
    const size = new THREE.Vector3(radius, radius, radius);
    this.enableClipBox(center, size);
  }

  disableClipBox(): void {
    this.clipBoxEnabled = false;
    this.clipBoxHelper?.visible && this.hideClipBoxHelper();
    this.applyClipBox();
  }

  private enableClipBox(center: THREE.Vector3, size: THREE.Vector3): void {
    this.clipBoxEnabled = true;
    const half = size.clone().multiplyScalar(0.5);
    this.clipBoxMin.copy(center).sub(half);
    this.clipBoxMax.copy(center).add(half);
    this.showClipBoxHelper(center, size);
    this.applyClipBox();
  }

  private applyClipBox(): void {
    if (!this.pointCloudEntity?.object3d) {
      return;
    }

    if (!this.clipBoxEnabled) {
      this.pointCloudEntity.object3d.traverse((child: any) => {
        if (child.isPoints) {
          child.visible = true;
        }
      });
      this.giro3dInstance?.notifyChange?.();
      return;
    }

    const clipBox = new THREE.Box3(this.clipBoxMin.clone(), this.clipBoxMax.clone());

    this.pointCloudEntity.object3d.traverse((child: any) => {
      if (!child.isPoints || !child.geometry?.boundingBox) return;

      const worldBox = child.geometry.boundingBox.clone().applyMatrix4(child.matrixWorld);
      child.visible = clipBox.intersectsBox(worldBox);
    });

    this.giro3dInstance?.notifyChange?.();
  }

  private showClipBoxHelper(center: THREE.Vector3, size: THREE.Vector3): void {
    if (!this.giro3dInstance?.scene) {
      return;
    }

    if (!this.clipBoxHelper) {
      const box = new THREE.Box3();
      box.setFromCenterAndSize(center, size);
      this.clipBoxHelper = new THREE.Box3Helper(box, new THREE.Color('#00ffff'));
      this.giro3dInstance.scene.add(this.clipBoxHelper);
    } else {
      this.clipBoxHelper.box.setFromCenterAndSize(center, size);
      this.clipBoxHelper.updateMatrixWorld(true);
      this.clipBoxHelper.visible = true;
    }
  }

  private hideClipBoxHelper(): void {
    if (this.clipBoxHelper) {
      this.clipBoxHelper.visible = false;
    }
  }

  /**
   * Compute and display concave hull boundary
   * DISABLED: Hull calculator removed
   */
  async computeAndShowHull(
    concavity: number = 2.0,
    sampleSize: number = 10000,
    use3D: boolean = true
  ): Promise<void> {
    console.warn('Hull computation is disabled');
    return;
  }

  /**
   * Toggle hull visibility
   */
  setHullVisible(visible: boolean): void {
    if (!this.hullVisualization) {
      if (visible) {
        // Compute hull if it doesn't exist
        this.computeAndShowHull(this.hullConcavity).catch(err =>
          console.error('Failed to compute hull:', err)
        );
      }
      return;
    }

    this.hullEnabled = visible;
    this.hullVisualization.visible = visible;
    this.giro3dInstance?.notifyChange?.();
  }

  /**
   * Update hull concavity and recompute
   */
  updateHullConcavity(concavity: number): void {
    this.hullConcavity = THREE.MathUtils.clamp(concavity, 1, 5);

    // Remove old hull
    if (this.hullVisualization && this.giro3dInstance?.scene) {
      this.giro3dInstance.scene.remove(this.hullVisualization);
      this.hullVisualization = null;
    }

    // Recompute if enabled
    if (this.hullEnabled) {
      this.computeAndShowHull(this.hullConcavity).catch(err =>
        console.error('Failed to recompute hull:', err)
      );
    }
  }

  /**
   * Update hull color
   */
  updateHullColor(color: number): void {
    this.hullColor = color;

    // Update existing visualization
    if (this.hullVisualization) {
      this.hullVisualization.traverse((child: any) => {
        if (child.material) {
          child.material.color.setHex(color);
          child.material.needsUpdate = true;
        }
      });
      this.giro3dInstance?.notifyChange?.();
    }
  }

  /**
   * Clean up hull visualization
   */
  private cleanupHull(): void {
    if (this.hullVisualization && this.giro3dInstance?.scene) {
      this.giro3dInstance.scene.remove(this.hullVisualization);
      this.hullVisualization = null;
      this.hullEnabled = false;
    }
  }

  setPointBudget(budget: number): void {
    if (!Number.isFinite(budget)) {
      return;
    }
    this.currentPointBudget = budget;
    if (this.pointCloudEntity) {
      this.pointCloudEntity.pointBudget = budget;
      this.giro3dInstance?.notifyChange?.();
    }
  }

  setBackgroundColor(color: 'black' | 'white' | 'gray'): void {
    this.backgroundColor = color;
    const colors = { black: 0x000000, white: 0xffffff, gray: 0x808080 };
    if (this.giro3dInstance?.scene) {
      this.giro3dInstance.scene.background = new THREE.Color(colors[color]);
      this.giro3dInstance?.notifyChange?.();
    }
  }

  setEDLEnabled(enabled: boolean): void {
    this.edlEnabled = enabled;
    if (this.giro3dInstance?.renderingOptions) {
      this.giro3dInstance.renderingOptions.enableEDL = enabled;
      this.giro3dInstance?.notifyChange?.();
    }
  }

  setCameraMode(mode: 'orbit' | 'fps' | 'fly' | 'walk' | 'plan'): void {
    // Map unsupported modes to nearest valid controls
    let normalized: 'orbit' | 'fps' | 'fly';
    switch (mode) {
      case 'walk':
        normalized = 'fps';
        break;
      case 'plan':
        normalized = 'orbit';
        break;
      default:
        normalized = mode;
    }
    this.cameraMode = normalized;
    // If control wiring per mode exists, apply it here (simplified in this reset)
  }

  enableXRayMode(opacity: number = 0.2): void {
    this.xrayModeEnabled = true;
    this.updateXRayOpacity(opacity);
  }

  disableXRayMode(): void {
    this.xrayModeEnabled = false;
    this.updateXRayOpacity(1.0);
  }

  updateXRayOpacity(opacity: number): void {
    if (!this.pointCloudEntity?.object3d) return;

    this.pointCloudEntity.object3d.traverse((child: any) => {
      if (child.material) {
        child.material.transparent = opacity < 1;
        child.material.opacity = opacity;
        child.material.needsUpdate = true;
      }
    });

    this.giro3dInstance?.notifyChange?.();
  }

  setPoleMarkerScale(scale: number): void {
    this.poleMarkerScale = THREE.MathUtils.clamp(scale, 0.2, 4);
    if (this.lastPoleMarkers.length > 0) {
      this.setPoleMarkers(this.lastPoleMarkers.map(pole => ({ ...pole })));
    } else if (this.pendingPoleMarkers) {
      this.pendingPoleMarkers = this.pendingPoleMarkers.map(pole => ({ ...pole }));
    }
  }

  setPoleLabelsVisible(visible: boolean): void {
    if (this.poleLabelsVisible === visible) {
      return;
    }
    this.poleLabelsVisible = visible;
    this.poleMarkerObjects.forEach(entry => {
      entry.sprite.visible = visible;
      if (!visible) {
        entry.sprite.scale.copy(entry.baseSpriteScale);
      }
    });
    if (visible && this.highlightedPoleId) {
      this.highlightPoleMarker(this.highlightedPoleId);
    }
    this.giro3dInstance?.notifyChange?.();
  }

  private getPoleMarkerDimensions(): {
    sphereRadius: number;
    markerLift: number;
    labelOffset: number;
  } {
    const scale = THREE.MathUtils.clamp(this.poleMarkerScale, 0.2, 4);
    const defaults = {
      sphereRadius: 0.75 * scale,
      markerLift: 0.85 * scale,
      labelOffset: 1.4 * scale
    };

    if (!this.pointCloudEntity?.boundingBox) {
      return defaults;
    }

    const size = new THREE.Vector3();
    this.pointCloudEntity.boundingBox.getSize(size);

    const horizontalExtent = Math.max(size.x, size.y);
    const verticalExtent = size.z || horizontalExtent;

    if (!Number.isFinite(horizontalExtent) || horizontalExtent <= 0) {
      return defaults;
    }

    const baseScale = Math.max(horizontalExtent, verticalExtent);
    const baseSphere = THREE.MathUtils.clamp(baseScale * 0.0012, 0.45, 1.5);
    const baseLift = baseSphere + THREE.MathUtils.clamp(baseScale * 0.0003, 0.05, 0.3);
    const baseLabel = Math.max(baseLift + baseSphere * 1.1, 0.9);

    const sphereRadius = THREE.MathUtils.clamp(baseSphere * scale, 0.2, 4);
    const markerLift = THREE.MathUtils.clamp(baseLift * scale, 0.25, 6);
    const labelOffset = THREE.MathUtils.clamp(baseLabel * scale, markerLift + 0.3, 10);

    return { sphereRadius, markerLift, labelOffset };
  }

  private resolveGroundHeight(x: number, y: number, fallbackZ: number | null | undefined): number | null {
    if (!this.pointCloudEntity?.object3d || !this.pointCloudEntity.boundingBox) {
      if (typeof fallbackZ === 'number' && Number.isFinite(fallbackZ)) {
        return fallbackZ;
      }
      return null;
    }

    const boundingBox = this.pointCloudEntity.boundingBox;
    const maxZ = boundingBox.max?.z;
    const minZ = boundingBox.min?.z;

    if (!Number.isFinite(maxZ) || !Number.isFinite(minZ)) {
      if (typeof fallbackZ === 'number' && Number.isFinite(fallbackZ)) {
        return fallbackZ;
      }
      return null;
    }

    const horizontalExtent = Math.max(
      Math.abs(boundingBox.max.x - boundingBox.min.x),
      Math.abs(boundingBox.max.y - boundingBox.min.y)
    );
    const searchRadius = THREE.MathUtils.clamp(horizontalExtent * 0.0025, 0.5, 6);

    const pickingPoints = this.samplePointsFromTopDown(x, y, searchRadius);
    if (pickingPoints.length > 0) {
      const filtered = pickingPoints.filter(point => {
        const dx = point.x - x;
        const dy = point.y - y;
        const distance = Math.sqrt(dx * dx + dy * dy);
        return Number.isFinite(distance) && distance <= searchRadius * 1.35;
      });
      const pickingHeights = filtered.map(point => point.z).filter(z => Number.isFinite(z));

      if (pickingHeights.length > 0) {
        pickingHeights.sort((a, b) => a - b);
        const sampleCount = Math.min(6, pickingHeights.length);
        const lowestSamples = pickingHeights.slice(0, sampleCount);
        const average = lowestSamples.reduce((sum, value) => sum + value, 0) / sampleCount;
        let candidate = Number.isFinite(average) ? average : pickingHeights[0];

        if (Number.isFinite(minZ)) {
          candidate = Math.max(candidate, minZ);
        }
        if (Number.isFinite(maxZ)) {
          candidate = Math.min(candidate, maxZ);
        }

        return candidate;
      }
    }

    const originZ = Math.max(
      maxZ + this.poleGroundSnapPadding,
      typeof fallbackZ === 'number' && Number.isFinite(fallbackZ)
        ? fallbackZ + this.poleGroundSnapPadding
        : -Infinity
    );
    const direction = new THREE.Vector3(0, 0, -1);
    direction.normalize();

    const raycaster = new THREE.Raycaster();
    raycaster.near = 0;
    raycaster.far = Math.max(1, originZ - (minZ - this.poleGroundSnapPadding));

    const offsets: Array<[number, number]> = [[0, 0]];
    const ringMultipliers = [0.25, 0.5, 0.85, 1];
    const rings = ringMultipliers
      .map(multiplier => searchRadius * multiplier)
      .filter((radius, index, array) => Number.isFinite(radius) && radius > 0.05 &&
        array.findIndex(other => Math.abs(other - radius) < 1e-3) === index);
    const baseDirections: Array<[number, number]> = [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
      [Math.SQRT1_2, Math.SQRT1_2],
      [-Math.SQRT1_2, Math.SQRT1_2],
      [Math.SQRT1_2, -Math.SQRT1_2],
      [-Math.SQRT1_2, -Math.SQRT1_2]
    ];

    rings.forEach(radius => {
      baseDirections.forEach(([dx, dy]) => {
        offsets.push([dx * radius, dy * radius]);
      });
    });

    const thresholds = [
      this.poleGroundSnapThreshold,
      this.poleGroundSnapThreshold * 1.5,
      this.poleGroundSnapThreshold * 2
    ];

    const origin = new THREE.Vector3();
    const collectedHeights: number[] = [];

    for (const threshold of thresholds) {
      raycaster.params.Points = { threshold };

      for (const [dx, dy] of offsets) {
        origin.set(x + dx, y + dy, originZ);
        raycaster.set(origin, direction);
        const hits = raycaster.intersectObject(this.pointCloudEntity.object3d, true);

        if (!Array.isArray(hits) || hits.length === 0) {
          continue;
        }

        let highestLocalZ = hits[0].point.z;
        for (let i = 1; i < hits.length; i += 1) {
          if (hits[i].point.z > highestLocalZ) {
            highestLocalZ = hits[i].point.z;
          }
        }

        if (Number.isFinite(highestLocalZ)) {
          collectedHeights.push(highestLocalZ);
        }
      }

      if (collectedHeights.length >= 6) {
        break;
      }
    }

    if (collectedHeights.length === 0) {
      if (typeof fallbackZ === 'number' && Number.isFinite(fallbackZ)) {
        return fallbackZ;
      }
      return minZ ?? null;
    }

    collectedHeights.sort((a, b) => a - b);
    const bottomSampleCount = Math.min(4, collectedHeights.length);
    const bottomSamples = collectedHeights.slice(0, bottomSampleCount);
    const averagedBottom = bottomSamples.reduce((sum, value) => sum + value, 0) / bottomSamples.length;
    let candidate = Number.isFinite(averagedBottom)
      ? averagedBottom
      : collectedHeights[0];

    if (Number.isFinite(minZ)) {
      candidate = Math.max(candidate, minZ);
    }
    if (Number.isFinite(maxZ)) {
      candidate = Math.min(candidate, maxZ);
    }

    return candidate;
  }

  getGroundSnappedHeight(
    x: number,
    y: number,
    fallbackZ?: number | null,
    options?: { maxDeviation?: number; verticalOffset?: number }
  ): number | null {
    const snapped = this.resolveGroundHeight(x, y, fallbackZ ?? null);
    const maxDeviation = options?.maxDeviation ?? 6;
    const verticalOffset = options?.verticalOffset ?? 0;

    if (!Number.isFinite(snapped) || snapped === null) {
      if (typeof fallbackZ === 'number' && Number.isFinite(fallbackZ)) {
        return fallbackZ + verticalOffset;
      }
      if (this.pointCloudEntity?.boundingBox) {
        return (this.pointCloudEntity.boundingBox.min.z ?? 0) + verticalOffset;
      }
      return verticalOffset;
    }

    if (typeof fallbackZ === 'number' && Number.isFinite(fallbackZ)) {
      if (Math.abs(snapped - fallbackZ) > maxDeviation) {
        return fallbackZ + verticalOffset;
      }
    }

    return snapped + verticalOffset;
  }

  private applyPendingPoleMarkers(): void {
    if (!this.pendingPoleMarkers || !this.giro3dInstance?.scene) {
      return;
    }

    const markers = [...this.pendingPoleMarkers];
    this.pendingPoleMarkers = null;
    this.setPoleMarkers(markers);
  }

  setPoleMarkers(poles: Array<{ id: string | number; name?: string | null; x: number; y: number; z: number | null }>): void {
    const isArray = Array.isArray(poles);
    const markersCopy = isArray ? poles.map(pole => ({ ...pole })) : [];

    if (!this.giro3dInstance?.scene) {
      this.lastPoleMarkers = markersCopy.map(pole => ({ ...pole }));
      this.pendingPoleMarkers = this.lastPoleMarkers.map(pole => ({ ...pole }));
      return;
    }

    this.clearPoleMarkers();
    this.pendingPoleMarkers = null;

    if (!isArray || markersCopy.length === 0) {
      this.lastPoleMarkers = [];
      return;
    }

    this.lastPoleMarkers = markersCopy.map(pole => ({ ...pole }));
    const markersToRender = this.lastPoleMarkers;
    const group = new THREE.Group();
    group.name = 'pole-markers';

    const dimensions = this.getPoleMarkerDimensions();

    markersToRender.forEach((pole, index) => {
      if (!Number.isFinite(pole.x) || !Number.isFinite(pole.y)) {
        return;
      }

      const markerId = String(pole.id ?? index);
      let baseZ: number | null = typeof pole.z === 'number' && Number.isFinite(pole.z) ? pole.z : null;

      if (baseZ === null) {
        const resolvedZ = this.resolveGroundHeight(pole.x, pole.y, null);
        if (typeof resolvedZ === 'number' && Number.isFinite(resolvedZ)) {
          baseZ = resolvedZ;
        } else {
          const bboxMinZ = this.pointCloudEntity?.boundingBox?.min?.z;
          baseZ = typeof bboxMinZ === 'number' && Number.isFinite(bboxMinZ) ? bboxMinZ : 0;
        }
      }

      pole.z = baseZ ?? 0;

      const sphereGeometry = new THREE.SphereGeometry(dimensions.sphereRadius, 18, 18);
      const sphereMaterial = new THREE.MeshBasicMaterial({
        color: this.poleMarkerDefaultColor,
        transparent: true,
        opacity: 0.95,
        depthTest: true,
        depthWrite: false
      });
      const markerMesh = new THREE.Mesh(sphereGeometry, sphereMaterial);
      markerMesh.name = `pole-marker-${markerId}`;
      markerMesh.position.set(0, 0, dimensions.markerLift);
      markerMesh.renderOrder = 10;
      markerMesh.frustumCulled = false;

      const { sprite, texture } = this.createPoleLabelSprite(
        pole.name ?? `Pole ${markerId}`,
        this.getPoleLabelScale()
      );
      sprite.position.set(0, 0, dimensions.labelOffset);
      sprite.renderOrder = 11;
      sprite.frustumCulled = false;
      sprite.visible = this.poleLabelsVisible;

      const poleGroup = new THREE.Group();
      poleGroup.name = `pole-${markerId}`;
      poleGroup.position.set(pole.x, pole.y, baseZ);
      poleGroup.matrixAutoUpdate = true;
      poleGroup.updateMatrixWorld(true);
      poleGroup.add(markerMesh);
      poleGroup.add(sprite);

      group.add(poleGroup);
      poleGroup.updateMatrixWorld(true);

      this.poleMarkerObjects.set(markerId, {
        group: poleGroup,
        mesh: markerMesh,
        sprite,
        texture,
        baseSpriteScale: sprite.scale.clone()
      });

    });

    if (group.children.length === 0) {
      this.disposePoleMarkersGroup(group);
      return;
    }

    group.frustumCulled = false;
    group.renderOrder = 8;
    this.giro3dInstance.scene.add(group);
    this.poleMarkersGroup = group;
    this.highlightedPoleId = null;
    this.pendingPoleMarkers = null;
    if (this.giro3dInstance.notifyChange) {
      this.giro3dInstance.notifyChange();
    }
  }

  clearPoleMarkers(): void {
    if (this.poleMarkersGroup && this.giro3dInstance?.scene) {
      this.giro3dInstance.scene.remove(this.poleMarkersGroup);
    }

    this.disposePoleMarkersGroup(this.poleMarkersGroup);
    this.poleMarkersGroup = null;
    this.poleMarkerObjects.forEach(entry => {
      entry.texture?.dispose?.();
    });
    this.poleMarkerObjects.clear();
    this.highlightedPoleId = null;
    this.lastPoleMarkers = [];
    this.pendingPoleMarkers = null;

    if (this.giro3dInstance?.notifyChange) {
      this.giro3dInstance.notifyChange();
    }
  }

  highlightPoleMarker(poleId: string | number | null): void {
    if (this.highlightedPoleId) {
      const previous = this.poleMarkerObjects.get(this.highlightedPoleId);
      if (previous && previous.mesh.material instanceof THREE.MeshBasicMaterial) {
        previous.mesh.material.color.setHex(this.poleMarkerDefaultColor);
        previous.mesh.material.needsUpdate = true;
        previous.sprite.scale.copy(previous.baseSpriteScale);
        const prevSpriteMaterial = previous.sprite.material as THREE.SpriteMaterial | undefined;
        prevSpriteMaterial?.color?.setHex(0xffffff);
        prevSpriteMaterial && (prevSpriteMaterial.needsUpdate = true);
      }
    }

    if (poleId === null || poleId === undefined) {
      this.highlightedPoleId = null;
      if (this.giro3dInstance?.notifyChange) {
        this.giro3dInstance.notifyChange();
      }
      return;
    }

    const markerId = String(poleId);
    const poleObject = this.poleMarkerObjects.get(markerId);
    if (poleObject && poleObject.mesh.material instanceof THREE.MeshBasicMaterial) {
      poleObject.mesh.material.color.setHex(this.poleMarkerHighlightColor);
      poleObject.mesh.material.needsUpdate = true;
      const spriteMaterial = poleObject.sprite.material as THREE.SpriteMaterial | undefined;
      if (this.poleLabelsVisible) {
        spriteMaterial?.color?.setHex(0xfff8e1);
        spriteMaterial && (spriteMaterial.needsUpdate = true);
        poleObject.sprite.scale.copy(poleObject.baseSpriteScale.clone().multiplyScalar(1.05));
      }
      this.highlightedPoleId = markerId;
      if (this.giro3dInstance?.notifyChange) {
        this.giro3dInstance.notifyChange();
      }
    } else {
      this.highlightedPoleId = null;
    }
  }

  private getPoleLabelScale(): number {
    return THREE.MathUtils.clamp(this.poleMarkerScale * 0.08, 0.035, 0.12);
  }

  private createPoleLabelSprite(name: string, scaleMultiplier: number): { sprite: THREE.Sprite; texture?: THREE.Texture | null } {
    if (typeof document === 'undefined') {
      const fallbackMaterial = new THREE.SpriteMaterial({ color: 0xffffff, depthTest: true, depthWrite: false });
      const fallbackSprite = new THREE.Sprite(fallbackMaterial);
      fallbackSprite.scale.set(12, 5, 1);
      return { sprite: fallbackSprite, texture: null };
    }

    const padding = 10;
    const fontSize = 32;
    const fontSpec = `600 ${fontSize}px "Inter", "Segoe UI", sans-serif`;
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d');

    if (!context) {
      const material = new THREE.SpriteMaterial({ color: 0xffffff, depthTest: true, depthWrite: false });
      const sprite = new THREE.Sprite(material);
      sprite.scale.set(12, 5, 1);
      return { sprite, texture: null };
    }

    context.font = fontSpec;
    const textMetrics = context.measureText(name);
    const textWidth = Math.ceil(textMetrics.width);

    const width = Math.ceil(textWidth + padding * 2);
    const height = Math.ceil(fontSize + padding * 2);

    canvas.width = width;
    canvas.height = height;

    context.font = fontSpec;
    context.textBaseline = 'middle';
    context.fillStyle = 'rgba(15, 23, 42, 0.7)';
    context.fillRect(0, 0, width, height);

    context.strokeStyle = 'rgba(148, 163, 184, 0.35)';
    context.lineWidth = 1;
    context.strokeRect(1, 1, width - 2, height - 2);

    context.fillStyle = '#ffffff';
    context.fillText(name, padding, height / 2);

    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = 4;
    texture.needsUpdate = true;

    const material = new THREE.SpriteMaterial({
      map: texture,
      transparent: true,
      depthTest: false,
      depthWrite: false,
    });

    const sprite = new THREE.Sprite(material);
    const scale = scaleMultiplier;
    sprite.scale.set(width * scale, height * scale, 1);

    return { sprite, texture };
  }

  private disposePoleMarkersGroup(group: THREE.Group | null): void {
    if (!group) {
      return;
    }

    group.traverse((object: THREE.Object3D) => {
      if ((object as any).isMesh) {
        const mesh = object as THREE.Mesh;
        if (mesh.geometry && typeof mesh.geometry.dispose === 'function') {
          mesh.geometry.dispose();
        }
        const material = mesh.material;
        if (Array.isArray(material)) {
          material.forEach(mat => {
            if (mat && typeof mat.dispose === 'function') {
              mat.dispose();
            }
          });
        } else if (material && typeof material.dispose === 'function') {
          material.dispose();
        }
      } else if ((object as any).isSprite) {
        const sprite = object as THREE.Sprite;
        const spriteMaterial = sprite.material as THREE.SpriteMaterial | undefined;
        spriteMaterial?.map?.dispose?.();
        spriteMaterial?.dispose?.();
      }
    });
  }

  async jumpToGroundLevel(): Promise<void> {
    const range = await this.getPointCloudHeightRange();
    if (!range || !this.controls || !this.giro3dInstance?.view?.camera) return;

    const camera = this.giro3dInstance.view.camera;
    const target = this.controls.target.clone();
    camera.position.set(target.x, target.y - 100, range.min + 10);
    camera.lookAt(target);
    this.controls.target.copy(target);
    this.controls.update();
    this.giro3dInstance.notifyChange();
  }

  async jumpToMidLevel(): Promise<void> {
    const range = await this.getPointCloudHeightRange();
    if (!range || !this.controls || !this.giro3dInstance?.view?.camera) return;

    const camera = this.giro3dInstance.view.camera;
    const target = this.controls.target.clone();
    const mid = (range.min + range.max) / 2;
    camera.position.set(target.x + 200, target.y - 200, mid + 100);
    camera.lookAt(target.x, target.y, mid);
    this.controls.target.set(target.x, target.y, mid);
    this.controls.update();
    this.giro3dInstance.notifyChange();
  }

  async jumpToAerialView(): Promise<void> {
    const range = await this.getPointCloudHeightRange();
    if (!range || !this.controls || !this.giro3dInstance?.view?.camera) return;

    const camera = this.giro3dInstance.view.camera;
    const target = this.controls.target.clone();
    camera.position.set(target.x, target.y - 500, range.max + 300);
    camera.lookAt(target);
    this.controls.target.z = (range.min + range.max) / 2;
    this.controls.update();
    this.giro3dInstance.notifyChange();
  }

  getCameraMode(): 'orbit' | 'fps' | 'fly' | 'walk' | 'plan' {
    return this.cameraMode;
  }

  setPoleEditingMode(active: boolean): void {
    if (!this.controls) {
      return;
    }

    this.editingControlsActive = active;
    const config = active ? this.controlEditing : this.controlBaseline;
    this.controls.enableDamping = config.enableDamping;
    this.controls.zoomSpeed = config.zoomSpeed;
    this.controls.panSpeed = config.panSpeed;
    this.controls.rotateSpeed = config.rotateSpeed;
  }

  private samplePointsFromTopDown(
    x: number,
    y: number,
    searchRadius: number
  ): THREE.Vector3[] {
    if (
      !this.pointCloudEntity?.object3d ||
      !this.pointCloudEntity.boundingBox ||
      !this.giro3dInstance?.engine
    ) {
      return [];
    }

    const boundingBox = this.pointCloudEntity.boundingBox;
    const minZ = boundingBox.min?.z ?? 0;
    const maxZ = boundingBox.max?.z ?? minZ;
    const originZ = maxZ + this.poleGroundSnapPadding;

    const near = 0.1;
    const far = Math.max(near + 1, originZ - (minZ - this.poleGroundSnapPadding));

    const camera = new THREE.OrthographicCamera(
      -searchRadius,
      searchRadius,
      searchRadius,
      -searchRadius,
      near,
      far
    );
    camera.position.set(x, y, originZ);
    camera.up.set(0, 1, 0);
    camera.lookAt(new THREE.Vector3(x, y, minZ - this.poleGroundSnapPadding));
    camera.updateProjectionMatrix();

    const pickingTargets = new Map<number, { material: any; points: THREE.Points }>();
    let objectId = 1;
    this.pointCloudEntity.object3d.traverse((object: any) => {
      if (!object || object.isPoints !== true || !object.visible) {
        return;
      }
      const material = object.material;
      if (!material || typeof material.enablePicking !== 'function') {
        return;
      }
      material.enablePicking(objectId);
      pickingTargets.set(objectId, { material, points: object });
      objectId += 1;
    });

    if (pickingTargets.size === 0) {
      return [];
    }

    const zoneSize = Math.max(16, Math.min(64, Math.ceil(searchRadius * 6)));
    const engineWidth = this.giro3dInstance.engine.width ?? zoneSize;
    const engineHeight = this.giro3dInstance.engine.height ?? zoneSize;
    const zone = {
      x: Math.max(0, Math.floor(engineWidth / 2 - zoneSize / 2)),
      y: Math.max(0, Math.floor(engineHeight / 2 - zoneSize / 2)),
      width: zoneSize,
      height: zoneSize
    };

    const buffer = this.giro3dInstance.engine.renderToBuffer({
      camera,
      scene: this.pointCloudEntity.object3d,
      clearColor: new THREE.Color(0, 0, 0),
      datatype: THREE.FloatType,
      zone
    }) as Float32Array;

    const hits: THREE.Vector3[] = [];
    const pixelCount = zone.width * zone.height;

    for (let i = 0; i < pixelCount; i += 1) {
      const baseIndex = i * 4;
      const pointIndex = Math.round(buffer[baseIndex]);
      const id = Math.round(buffer[baseIndex + 1]);
      if (id <= 0 || pointIndex < 0) {
        continue;
      }

      const target = pickingTargets.get(id);
      if (!target) {
        continue;
      }

      const positions = target.points.geometry?.getAttribute('position');
      if (!positions || pointIndex >= positions.count) {
        continue;
      }

      const worldPoint = new THREE.Vector3(
        positions.getX(pointIndex),
        positions.getY(pointIndex),
        positions.getZ(pointIndex)
      ).applyMatrix4(target.points.matrixWorld);
      hits.push(worldPoint);
    }

    pickingTargets.forEach(({ material }) => {
      try {
        material.enablePicking(0);
      } catch (error) {
        console.warn('Failed to disable picking material:', error);
      }
    });

    return hits;
  }

  pickPointDetailed(
    screenX: number,
    screenY: number,
    options?: { radiusPx?: number; filter?: (result: PointPickResult) => boolean }
  ): PointPickResult | null {
    if (!this.pointCloudEntity || !this.giro3dInstance?.domElement || !this.giro3dInstance?.engine) {
      return null;
    }

    const canvas: HTMLCanvasElement = this.giro3dInstance.domElement;
    const rect = canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) {
      return null;
    }

    const engineWidth = this.giro3dInstance.engine.width ?? canvas.width ?? rect.width;
    const engineHeight = this.giro3dInstance.engine.height ?? canvas.height ?? rect.height;
    if (!Number.isFinite(engineWidth) || !Number.isFinite(engineHeight)) {
      return null;
    }

    const ratioX = engineWidth / rect.width;
    const ratioY = engineHeight / rect.height;
    const canvasX = (screenX - rect.left) * ratioX;
    const canvasY = (rect.bottom - screenY) * ratioY;

    const picks = this.pointCloudEntity.pick(new THREE.Vector2(canvasX, canvasY), {
      radius: options?.radiusPx ?? 3,
      limit: 16
    });

    if (!Array.isArray(picks) || picks.length === 0) {
      return null;
    }

    const enriched = picks
      .filter(pick => pick?.point instanceof THREE.Vector3)
      .map(pick => {
        const distance = pick.distance ?? this.giro3dInstance.view.camera.position.distanceTo(pick.point);
        const attributes = (pick as any)?.attributes ?? {};

        const classificationSources = [
          attributes.classification,
          attributes.Classification,
          (pick as any)?.classification,
          (pick as any)?.Classification,
        ];
        const classification =
          classificationSources.find(value => typeof value === 'number' && Number.isFinite(value)) ?? null;

        const rawColor =
          attributes.color ??
          attributes.Color ??
          (pick as any)?.color ??
          (pick as any)?.pointColor ??
          null;
        let color: { r: number; g: number; b: number } | null = null;
        if (rawColor) {
          if (Array.isArray(rawColor) && rawColor.length >= 3) {
            color = { r: rawColor[0], g: rawColor[1], b: rawColor[2] };
          } else if (
            typeof rawColor === 'object' &&
            rawColor !== null &&
            typeof rawColor.r === 'number' &&
            typeof rawColor.g === 'number' &&
            typeof rawColor.b === 'number'
          ) {
            color = { r: rawColor.r, g: rawColor.g, b: rawColor.b };
          }
        }

        const indexSources = [
          attributes.pointIndex,
          attributes.index,
          (pick as any)?.pointIndex,
          (pick as any)?.index,
        ];
        const pointIndex =
          indexSources.find(value => typeof value === 'number' && Number.isFinite(value)) ?? null;

        return {
          position: pick.point.clone(),
          distance,
          classification,
          color,
          pointIndex,
        };
      })
      .filter(entry => Number.isFinite(entry.distance));

    if (enriched.length === 0) {
      return null;
    }

    enriched.sort((a, b) => (a.distance! - b.distance!));
    const pickCandidate = enriched[0];

    const selected = options?.filter
      ? enriched.find(result => options.filter!(result)) ?? pickCandidate
      : pickCandidate;

    return {
      position: selected.position.clone(),
      classification: selected.classification ?? null,
      color: selected.color ?? null,
      pointIndex: selected.pointIndex ?? null,
    };
  }

  pickPointAtScreen(
    screenX: number,
    screenY: number,
    options?: { radiusPx?: number; filter?: (point: THREE.Vector3) => boolean }
  ): THREE.Vector3 | null {
    const result = this.pickPointDetailed(screenX, screenY, {
      radiusPx: options?.radiusPx,
      filter: options?.filter
        ? (pick) => options.filter!(pick.position)
        : undefined,
    });
    return result?.position ?? null;
  }

  getTeleportPoint(screenX: number, screenY: number): THREE.Vector3 | null {
    const point = this.pickPointAtScreen(screenX, screenY);
    return point ? point.clone() : null;
  }

  teleportToPoint(worldPoint: THREE.Vector3, offset: number = 100): void {
    const camera = this.getCamera();
    if (!camera || !this.controls) {
      return;
    }

    const direction = camera.getWorldDirection(new THREE.Vector3()).normalize();
    camera.position.copy(worldPoint).add(direction.multiplyScalar(-offset));
    this.controls.target.copy(worldPoint);
    this.controls.update();
    this.giro3dInstance?.notifyChange?.();
  }

  renderClusterOverlay(patches: ClusterOverlayPatch[]): void {
    this.clearClusterOverlay();
    if (!patches?.length) {
      return;
    }
    const scene = this.giro3dInstance?.scene;
    if (!scene) {
      return;
    }

    const positions = new Float32Array(patches.length * 3);
    const colors = new Float32Array(patches.length * 3);

    patches.forEach((patch, idx) => {
      const base = idx * 3;
      const [x, y, z] = patch.centroid;
      positions[base] = x;
      positions[base + 1] = y;
      positions[base + 2] = z;

      const color = this.getClusterColor(patch.cluster);
      colors[base] = color.r;
      colors[base + 1] = color.g;
      colors[base + 2] = color.b;
    });

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));

    const material = new THREE.PointsMaterial({
      size: 1.6,
      sizeAttenuation: true,
      vertexColors: true,
      transparent: true,
      opacity: 0.9,
      depthTest: true,
    });

    this.clusterOverlayLayer = new THREE.Points(geometry, material);
    this.clusterOverlayLayer.renderOrder = 1000;
    scene.add(this.clusterOverlayLayer);
    this.giro3dInstance?.notifyChange?.();
  }

  clearClusterOverlay(): void {
    if (!this.clusterOverlayLayer) {
      return;
    }
    const scene = this.giro3dInstance?.scene;
    if (scene) {
      scene.remove(this.clusterOverlayLayer);
    }
    this.clusterOverlayLayer.geometry.dispose();
    (this.clusterOverlayLayer.material as THREE.Material)?.dispose?.();
    this.clusterOverlayLayer = null;
    this.giro3dInstance?.notifyChange?.();
  }

  private getClusterColor(clusterId: number): THREE.Color {
    const cached = this.clusterColorCache.get(clusterId);
    if (cached) {
      return cached;
    }
    const hue = (clusterId * 53) % 360;
    const color = new THREE.Color().setHSL(hue / 360, 0.65, 0.55);
    this.clusterColorCache.set(clusterId, color);
    return color;
  }
}
