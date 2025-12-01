import * as THREE from 'three';

export interface MeasurementVisualizerContext {
  getScene(): THREE.Scene | null;
  notifyChange(): void;
}

interface MeasurementGroup {
  id: number;
  line: THREE.Mesh; // Tube mesh for thick visible lines
  markers: THREE.Mesh[];
  label?: THREE.Sprite | null;
}

export class MeasurementVisualizer {
  private measurements: Map<number, MeasurementGroup> = new Map();
  private selectedMeasurementId: number | null = null;
  private previewLine: THREE.Line | null = null;
  private previewMarker: THREE.Mesh | null = null;

  constructor(private readonly context: MeasurementVisualizerContext) {}

  async addMeasurementLine(
    point1: THREE.Vector3,
    point2: THREE.Vector3,
    id: number,
    distance?: number
  ): Promise<void> {
    const scene = this.context.getScene();

    if (!scene) {
      console.warn('Cannot add measurement line: scene not available');
      return;
    }

    try {
      // Calculate distance and direction
      const direction = new THREE.Vector3().subVectors(point2, point1);
      const length = direction.length();

      console.log(`🔧 Creating measurement line ${id}:`);
      console.log(`   Point 1: (${point1.x.toFixed(2)}, ${point1.y.toFixed(2)}, ${point1.z.toFixed(2)})`);
      console.log(`   Point 2: (${point2.x.toFixed(2)}, ${point2.y.toFixed(2)}, ${point2.z.toFixed(2)})`);
      console.log(`   Length: ${length.toFixed(2)}m`);

      // Use TubeGeometry for better visibility - create a path from point1 to point2
      const curve = new THREE.LineCurve3(point1, point2);
      const tubeRadius = Math.max(0.15, length * 0.002); // Thinner, more refined lines
      console.log(`   Tube radius: ${tubeRadius.toFixed(2)}`);

      const tubeGeometry = new THREE.TubeGeometry(curve, 4, tubeRadius, 8, false);
      const tubeMaterial = new THREE.MeshBasicMaterial({
        color: 0xff6600, // Bright orange
        depthTest: false,
        depthWrite: false,
        transparent: true,
        opacity: 1.0,
        side: THREE.DoubleSide
      });

      const line = new THREE.Mesh(tubeGeometry, tubeMaterial);
      line.userData = { type: 'measurement-line', id };
      line.renderOrder = 9999; // Very high render order to ensure it's on top

      scene.add(line);
      console.log(`   ✅ Tube mesh added to scene`);

      // Create markers
      const markers = await this.createMeasurementMarkers(point1, point2, id);

      // Create distance label
      const label = this.createDistanceLabel(point1, point2, distance || point1.distanceTo(point2));
      if (label) {
        scene.add(label);
      }

      // Store the measurement group
      this.measurements.set(id, {
        id,
        line,
        markers,
        label
      });

      this.context.notifyChange();
      console.log(`✅ Measurement line ${id} fully added to 3D scene`);
    } catch (error) {
      console.error('Failed to add measurement line:', error);
      console.error('Error details:', error);
    }
  }

  private async createMeasurementMarkers(
    point1: THREE.Vector3,
    point2: THREE.Vector3,
    id: number
  ): Promise<THREE.Mesh[]> {
    const scene = this.context.getScene();

    if (!scene) {
      return [];
    }

    try {
      const sphereGeometry = new THREE.SphereGeometry(1.0, 16, 16);

      // Create larger, brighter sphere markers
      const marker1 = new THREE.Mesh(
        sphereGeometry,
        new THREE.MeshBasicMaterial({
          color: 0xff0000,
          depthTest: false,
          depthWrite: false,
          transparent: true,
          opacity: 1.0
        })
      );
      marker1.position.copy(point1);
      marker1.userData = { type: 'measurement-marker', id, pointIndex: 0 };
      marker1.renderOrder = 10000; // Higher than measurement lines

      const marker2 = new THREE.Mesh(
        sphereGeometry.clone(),
        new THREE.MeshBasicMaterial({
          color: 0xff0000,
          depthTest: false,
          depthWrite: false,
          transparent: true,
          opacity: 1.0
        })
      );
      marker2.position.copy(point2);
      marker2.userData = { type: 'measurement-marker', id, pointIndex: 1 };
      marker2.renderOrder = 10000; // Higher than measurement lines

      scene.add(marker1);
      scene.add(marker2);

      console.log(`✅ Added measurement markers for measurement ${id}`);
      return [marker1, marker2];
    } catch (error) {
      console.error('Failed to add measurement markers:', error);
      return [];
    }
  }

  // Preview line for real-time feedback while measuring
  showPreviewLine(point1: THREE.Vector3): void {
    const scene = this.context.getScene();
    if (!scene) return;

    // Create preview marker at first point
    if (!this.previewMarker) {
      const geometry = new THREE.SphereGeometry(1.0, 16, 16);
      const material = new THREE.MeshBasicMaterial({
        color: 0x00ff00,
        depthTest: false,
        depthWrite: false,
        transparent: true,
        opacity: 1.0
      });
      this.previewMarker = new THREE.Mesh(geometry, material);
      this.previewMarker.renderOrder = 10001; // On top of everything
      scene.add(this.previewMarker);
    }
    this.previewMarker.position.copy(point1);

    // Create preview line (using simple line for performance)
    if (!this.previewLine) {
      const geometry = new THREE.BufferGeometry().setFromPoints([
        point1.clone(),
        point1.clone() // Will be updated
      ]);
      const material = new THREE.LineBasicMaterial({
        color: 0x00ff00,
        linewidth: 2,
        depthTest: false,
        depthWrite: false,
        transparent: true,
        opacity: 1.0
      });
      this.previewLine = new THREE.Line(geometry, material);
      this.previewLine.renderOrder = 10001; // On top of everything
      scene.add(this.previewLine);
    }

    this.context.notifyChange();
  }

  updatePreviewLine(point1: THREE.Vector3, point2: THREE.Vector3): void {
    if (!this.previewLine) return;

    // Update line geometry
    const positions = new Float32Array([
      point1.x, point1.y, point1.z,
      point2.x, point2.y, point2.z
    ]);
    this.previewLine.geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    this.previewLine.geometry.attributes['position'].needsUpdate = true;

    this.context.notifyChange();
  }

  hidePreviewLine(): void {
    const scene = this.context.getScene();
    if (!scene) return;

    if (this.previewLine) {
      scene.remove(this.previewLine);
      this.previewLine.geometry.dispose();
      (this.previewLine.material as THREE.Material).dispose();
      this.previewLine = null;
    }

    if (this.previewMarker) {
      scene.remove(this.previewMarker);
      this.previewMarker.geometry.dispose();
      (this.previewMarker.material as THREE.Material).dispose();
      this.previewMarker = null;
    }

    this.context.notifyChange();
  }

  private createDistanceLabel(
    point1: THREE.Vector3,
    point2: THREE.Vector3,
    distance: number
  ): THREE.Sprite | null {
    try {
      // Create a canvas to draw text
      const canvas = document.createElement('canvas');
      const context = canvas.getContext('2d');
      if (!context) return null;

      // Set canvas size
      canvas.width = 512;
      canvas.height = 128;

      // Configure text style
      context.fillStyle = 'rgba(0, 0, 0, 0.7)';
      context.fillRect(0, 0, canvas.width, canvas.height);

      context.font = 'bold 60px Arial';
      context.fillStyle = '#ffffff';
      context.textAlign = 'center';
      context.textBaseline = 'middle';

      // Format distance text
      const distanceText = `${distance.toFixed(2)}m`;
      context.fillText(distanceText, canvas.width / 2, canvas.height / 2);

      // Create texture from canvas
      const texture = new THREE.CanvasTexture(canvas);
      texture.needsUpdate = true;

      // Create sprite material
      const spriteMaterial = new THREE.SpriteMaterial({
        map: texture,
        transparent: true,
        depthTest: true,
        depthWrite: false,
        opacity: 0.95
      });

      // Create sprite
      const sprite = new THREE.Sprite(spriteMaterial);

      // Position at midpoint, slightly offset upward
      const midpoint = new THREE.Vector3().addVectors(point1, point2).multiplyScalar(0.5);
      const offsetDistance = point1.distanceTo(point2) * 0.1;
      midpoint.z += offsetDistance; // Offset upward

      sprite.position.copy(midpoint);

      // Scale sprite based on distance (keep readable size)
      const scale = Math.max(distance * 0.15, 5);
      sprite.scale.set(scale, scale * 0.25, 1);
      sprite.renderOrder = 10002; // Render on top of everything

      return sprite;
    } catch (error) {
      console.error('Failed to create distance label:', error);
      return null;
    }
  }

  removeMeasurementLine(id: number): void {
    const scene = this.context.getScene();

    if (!scene) {
      return;
    }

    try {
      const measurement = this.measurements.get(id);
      if (!measurement) {
        return;
      }

      // Remove line (tube mesh)
      scene.remove(measurement.line);
      measurement.line.geometry.dispose();
      (measurement.line.material as THREE.Material).dispose();

      // Remove markers
      measurement.markers.forEach(marker => {
        scene.remove(marker);
        marker.geometry.dispose();
        (marker.material as THREE.Material).dispose();
      });

      // Remove label
      if (measurement.label) {
        scene.remove(measurement.label);
        measurement.label.material.map?.dispose();
        measurement.label.material.dispose();
      }

      this.measurements.delete(id);

      this.context.notifyChange();
      console.log(`✅ Removed measurement ${id} from 3D scene`);
    } catch (error) {
      console.error('Failed to remove measurement line:', error);
    }
  }

  clearMeasurements(): void {
    const scene = this.context.getScene();

    if (!scene) {
      return;
    }

    try {
      this.measurements.forEach((measurement) => {
        // Remove line (tube mesh)
        scene.remove(measurement.line);
        measurement.line.geometry.dispose();
        (measurement.line.material as THREE.Material).dispose();

        // Remove markers
        measurement.markers.forEach(marker => {
          scene.remove(marker);
          marker.geometry.dispose();
          (marker.material as THREE.Material).dispose();
        });

        // Remove label
        if (measurement.label) {
          scene.remove(measurement.label);
          measurement.label.material.map?.dispose();
          measurement.label.material.dispose();
        }
      });

      this.measurements.clear();
      this.selectedMeasurementId = null;

      this.context.notifyChange();
      console.log('✅ Cleared all measurements from 3D scene');
    } catch (error) {
      console.error('Failed to clear measurements:', error);
    }
  }

  setSelectedMeasurement(id: number | null): void {
    if (this.selectedMeasurementId === id) {
      return;
    }

    // Unhighlight previous selection
    if (this.selectedMeasurementId !== null) {
      this.highlightMeasurement(this.selectedMeasurementId, false);
    }

    this.selectedMeasurementId = id;

    // Highlight new selection
    if (id !== null) {
      this.highlightMeasurement(id, true);
    }

    this.context.notifyChange();
  }

  private highlightMeasurement(id: number, highlighted: boolean): void {
    const measurement = this.measurements.get(id);
    if (!measurement) {
      return;
    }

    const highlightColor = 0x00ff00; // Green for selected
    const normalColor = 0xff6600; // Orange for normal

    const color = highlighted ? highlightColor : normalColor;

    // Update tube mesh color
    (measurement.line.material as THREE.MeshBasicMaterial).color.setHex(color);

    // Update marker size and color
    const markerScale = highlighted ? 1.5 : 1.0;
    measurement.markers.forEach(marker => {
      marker.scale.set(markerScale, markerScale, markerScale);
      if (highlighted) {
        (marker.material as THREE.MeshBasicMaterial).color.setHex(0x00ff00);
      } else {
        (marker.material as THREE.MeshBasicMaterial).color.setHex(0xff0000);
      }
    });
  }
}
