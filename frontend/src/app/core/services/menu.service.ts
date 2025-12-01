import { Injectable } from '@angular/core';
import { Router } from '@angular/router';
import { BehaviorSubject, Observable, Subject } from 'rxjs';
import { FrustumCulledCOPCService } from './frustum-culled-copc.service';
import { PointCloudService } from './point-cloud.service';
import { MeasurementService } from './measurement.service';

export interface MenuItem {
  label?: string;
  icon?: string;
  action?: () => void;
  shortcut?: string;
  submenu?: MenuItem[];
  separator?: boolean;
  disabled?: boolean;
  hidden?: boolean;
}

export interface Menu {
  label: string;
  items: MenuItem[];
}

export interface MenuState {
  canUndo: boolean;
  canRedo: boolean;
  hasMeasurements: boolean;
  hasPointCloud: boolean;
  currentColorMode: 'rgb' | 'elevation' | 'classification' | 'intensity';
  isPanelVisible: boolean;
  isStatsVisible: boolean;
  isGridVisible: boolean;
  isAxesVisible: boolean;
}

@Injectable({
  providedIn: 'root'
})
export class MenuService {
  private menuState$ = new BehaviorSubject<MenuState>({
    canUndo: false,
    canRedo: false,
    hasMeasurements: false,
    hasPointCloud: false,
    currentColorMode: 'rgb',
    isPanelVisible: true,
    isStatsVisible: false,
    isGridVisible: false,
    isAxesVisible: false
  });

  // Event emitters for menu actions
  private exportScreenshotRequested$ = new Subject<void>();
  private exportMeasurementsRequested$ = new Subject<void>();
  private exportPointCloudRequested$ = new Subject<void>();
  private showPreferencesRequested$ = new Subject<void>();
  private showKeyboardShortcutsRequested$ = new Subject<void>();
  private showAboutRequested$ = new Subject<void>();
  private togglePanelsRequested$ = new Subject<void>();
  private toggleStatsRequested$ = new Subject<void>();
  private toggleGridRequested$ = new Subject<void>();
  private toggleAxesRequested$ = new Subject<void>();
  private cameraViewRequested$ = new Subject<string>();

  constructor(
    private router: Router
  ) {}

  // Observables
  getMenuState(): Observable<MenuState> {
    return this.menuState$.asObservable();
  }

  onExportScreenshotRequested(): Observable<void> {
    return this.exportScreenshotRequested$.asObservable();
  }

  onExportMeasurementsRequested(): Observable<void> {
    return this.exportMeasurementsRequested$.asObservable();
  }

  onExportPointCloudRequested(): Observable<void> {
    return this.exportPointCloudRequested$.asObservable();
  }

  onShowPreferencesRequested(): Observable<void> {
    return this.showPreferencesRequested$.asObservable();
  }

  onShowKeyboardShortcutsRequested(): Observable<void> {
    return this.showKeyboardShortcutsRequested$.asObservable();
  }

  onShowAboutRequested(): Observable<void> {
    return this.showAboutRequested$.asObservable();
  }

  onTogglePanelsRequested(): Observable<void> {
    return this.togglePanelsRequested$.asObservable();
  }

  onToggleStatsRequested(): Observable<void> {
    return this.toggleStatsRequested$.asObservable();
  }

  onToggleGridRequested(): Observable<void> {
    return this.toggleGridRequested$.asObservable();
  }

  onToggleAxesRequested(): Observable<void> {
    return this.toggleAxesRequested$.asObservable();
  }

  onCameraViewRequested(): Observable<string> {
    return this.cameraViewRequested$.asObservable();
  }

  // State updates
  updateMenuState(partialState: Partial<MenuState>): void {
    const currentState = this.menuState$.value;
    this.menuState$.next({ ...currentState, ...partialState });
  }

  // Menu structure
  getFileMenu(): MenuItem[] {
    const state = this.menuState$.value;

    return [
      {
        label: 'Close',
        icon: 'close',
        action: () => this.router.navigate(['/point-clouds']),
        shortcut: 'Ctrl+W'
      },
      { separator: true },
      {
        label: 'Export Screenshot',
        icon: 'photo_camera',
        action: () => this.exportScreenshotRequested$.next(),
        shortcut: 'Ctrl+Shift+S',
        disabled: !state.hasPointCloud
      },
      {
        label: 'Export Measurements',
        icon: 'straighten',
        action: () => this.exportMeasurementsRequested$.next(),
        disabled: !state.hasMeasurements
      },
      {
        label: 'Export Point Cloud...',
        icon: 'cloud_download',
        action: () => this.exportPointCloudRequested$.next(),
        disabled: !state.hasPointCloud
      }
    ];
  }

  getEditMenu(): MenuItem[] {
    const state = this.menuState$.value;

    return [
      {
        label: 'Undo',
        icon: 'undo',
        action: () => {
          // Will be handled by viewer component
        },
        shortcut: 'Ctrl+Z',
        disabled: !state.canUndo
      },
      {
        label: 'Redo',
        icon: 'redo',
        action: () => {
          // Will be handled by viewer component
        },
        shortcut: 'Ctrl+Shift+Z',
        disabled: !state.canRedo
      },
      { separator: true },
      {
        label: 'Preferences...',
        icon: 'settings',
        action: () => this.showPreferencesRequested$.next(),
        shortcut: 'Ctrl+,'
      }
    ];
  }

  getViewMenu(): MenuItem[] {
    const state = this.menuState$.value;

    return [
      {
        label: 'Camera Views',
        icon: 'videocam',
        submenu: [
          {
            label: 'Top View',
            icon: 'vertical_align_top',
            action: () => this.cameraViewRequested$.next('top'),
            shortcut: 'Alt+1'
          },
          {
            label: 'Front View',
            icon: 'view_in_ar',
            action: () => this.cameraViewRequested$.next('front'),
            shortcut: 'Alt+2'
          },
          {
            label: 'Side View',
            icon: 'view_in_ar',
            action: () => this.cameraViewRequested$.next('side'),
            shortcut: 'Alt+3'
          },
          {
            label: 'Isometric View',
            icon: 'view_in_ar',
            action: () => this.cameraViewRequested$.next('isometric'),
            shortcut: 'Alt+4'
          },
          { separator: true },
          {
            label: 'Reset View',
            icon: 'center_focus_strong',
            action: () => this.cameraViewRequested$.next('reset'),
            shortcut: 'R'
          }
        ]
      },
      { separator: true },
      {
        label: 'Color Scheme',
        icon: 'palette',
        submenu: [
          {
            label: 'RGB Color',
            icon: state.currentColorMode === 'rgb' ? 'check' : undefined,
            action: () => {
              // Will be handled by viewer component
            },
            shortcut: '1'
          },
          {
            label: 'Elevation',
            icon: state.currentColorMode === 'elevation' ? 'check' : undefined,
            action: () => {
              // Will be handled by viewer component
            },
            shortcut: '2'
          },
          {
            label: 'Classification',
            icon: state.currentColorMode === 'classification' ? 'check' : undefined,
            action: () => {
              // Will be handled by viewer component
            },
            shortcut: '3'
          },
          {
            label: 'Intensity',
            icon: state.currentColorMode === 'intensity' ? 'check' : undefined,
            action: () => {
              // Will be handled by viewer component
            },
            shortcut: '4'
          }
        ]
      },
      { separator: true },
      {
        label: 'Toggle Panels',
        icon: 'dashboard',
        action: () => this.togglePanelsRequested$.next(),
        shortcut: 'P'
      },
      {
        label: state.isStatsVisible ? 'Hide Statistics' : 'Show Statistics',
        icon: 'analytics',
        action: () => this.toggleStatsRequested$.next(),
        shortcut: 'S'
      },
      { separator: true },
      {
        label: state.isGridVisible ? 'Hide Grid' : 'Show Grid',
        icon: 'grid_on',
        action: () => this.toggleGridRequested$.next(),
        shortcut: 'G'
      },
      {
        label: state.isAxesVisible ? 'Hide Axes' : 'Show Axes',
        icon: 'explore',
        action: () => this.toggleAxesRequested$.next(),
        shortcut: 'X'
      },
      { separator: true },
      {
        label: 'Fullscreen',
        icon: 'fullscreen',
        action: () => {
          // Will be handled by viewer component
        },
        shortcut: 'F'
      }
    ];
  }

  getToolsMenu(): MenuItem[] {
    const state = this.menuState$.value;

    return [
      {
        label: 'Measurement Tools',
        icon: 'straighten',
        submenu: [
          {
            label: 'Distance Measurement',
            icon: 'straighten',
            action: () => {
              // Will be handled by viewer component
            },
            shortcut: 'M'
          },
          {
            label: 'Point Info',
            icon: 'info',
            action: () => {
              // Will be handled by viewer component
            },
            shortcut: 'I'
          }
        ]
      },
      {
        label: 'Selection Tools',
        icon: 'select_all',
        submenu: [
          {
            label: 'Lasso Selection',
            icon: 'gesture',
            action: () => {
              // Will be handled by viewer component
            },
            shortcut: 'L'
          }
        ]
      },
      { separator: true },
      {
        label: 'Classification Editor',
        icon: 'category',
        action: () => {
          // Will be handled by viewer component
        },
        shortcut: 'C'
      },
      { separator: true },
      {
        label: 'Annotations',
        icon: 'comment',
        action: () => {
          // Future feature
        },
        disabled: true
      },
      {
        label: 'Volume Calculator',
        icon: 'view_in_ar',
        action: () => {
          // Future feature
        },
        disabled: true
      },
      {
        label: 'Area Calculator',
        icon: 'crop_square',
        action: () => {
          // Future feature
        },
        disabled: true
      },
      {
        label: 'Cross Section',
        icon: 'content_cut',
        action: () => {
          // Future feature
        },
        disabled: true
      }
    ];
  }

  getHelpMenu(): MenuItem[] {
    return [
      {
        label: 'Keyboard Shortcuts',
        icon: 'keyboard',
        action: () => this.showKeyboardShortcutsRequested$.next(),
        shortcut: '?'
      },
      {
        label: 'Documentation',
        icon: 'help',
        action: () => {
          window.open('https://github.com/your-org/pointcloud-viewer', '_blank');
        }
      },
      { separator: true },
      {
        label: 'About',
        icon: 'info',
        action: () => this.showAboutRequested$.next()
      }
    ];
  }

  getAllMenus(): Menu[] {
    return [
      { label: 'File', items: this.getFileMenu() },
      { label: 'Edit', items: this.getEditMenu() },
      { label: 'View', items: this.getViewMenu() },
      { label: 'Tools', items: this.getToolsMenu() },
      { label: 'Help', items: this.getHelpMenu() }
    ];
  }
}
