export type CameraMode = 'orbit' | 'walk' | 'fly' | 'plan' | 'fps';

export interface CameraSettings {
  rotationSensitivity: number;
  panSensitivity: number;
  zoomSensitivity: number;
  enableDamping: boolean;
  dampingFactor: number;
}

export interface CameraBookmark {
  id: string;
  name: string;
  position: { x: number; y: number; z: number };
  target: { x: number; y: number; z: number };
  timestamp: string;
}

export interface CameraPreferences {
  mode: CameraMode;
  settings: CameraSettings;
  bookmarks: CameraBookmark[];
  lastUsed: string;
}
