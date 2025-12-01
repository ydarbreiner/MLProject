import { Component, OnInit, OnDestroy, HostListener } from '@angular/core';
import { RouterModule, Router, NavigationEnd } from '@angular/router';
import { CommonModule } from '@angular/common';
import { MatToolbarModule } from '@angular/material/toolbar';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatDialogModule, MatDialog } from '@angular/material/dialog';
import { MatMenuModule } from '@angular/material/menu';
import { MatDividerModule } from '@angular/material/divider';
import { MatBadgeModule } from '@angular/material/badge';
import { MatSlideToggleModule } from '@angular/material/slide-toggle';
import { BehaviorSubject, Observable, interval, Subject } from 'rxjs';
import { filter, map, takeUntil, startWith } from 'rxjs/operators';
import { PointCloudService } from 'src/app/core/services/point-cloud.service';
import { ThemeService, Theme } from 'src/app/core/services/theme.service';
import { PointCloud } from 'src/app/core/models/point-cloud.model';

// Notification interface for type safety
interface SystemNotification {
  id: string;
  type: 'info' | 'warning' | 'error' | 'success';
  message: string;
  timestamp: Date;
}

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [
    CommonModule,
    RouterModule,
    MatToolbarModule,
    MatIconModule,
    MatButtonModule,
    MatProgressSpinnerModule,
    MatTooltipModule,
    MatDialogModule,
    MatMenuModule,
    MatDividerModule,
    MatBadgeModule,
    MatSlideToggleModule
  ],
  templateUrl: './app.html',
  styleUrls: ['./app.scss'],
})
export class AppComponent implements OnInit, OnDestroy {
  private destroy$ = new Subject<void>();

  // App properties
  title = 'Point Cloud Viewer';
  isFullscreen = false;

  // Observable properties for template
  currentRoute$: Observable<string>;
  isUploadPage$: Observable<boolean>;
  currentTheme$: Observable<Theme>;
  memoryUsage$ = new BehaviorSubject<number>(0);
  connectionStatus$ = new BehaviorSubject<'connected' | 'disconnected'>('connected');
  activePointClouds$ = new BehaviorSubject<number>(0);
  processingQueue$ = new BehaviorSubject<number>(0);
  isGlobalLoading$ = new BehaviorSubject<boolean>(false);
  notifications$ = new BehaviorSubject<SystemNotification[]>([]);

  constructor(
    public router: Router,
    private dialog: MatDialog,
    private pointCloudService: PointCloudService,
    private themeService: ThemeService
  ) {
    // Setup current route tracking
    this.currentRoute$ = this.router.events.pipe(
      filter(event => event instanceof NavigationEnd),
      map((event: NavigationEnd) => this.getRouteDisplayName(event.url)),
      startWith(this.getRouteDisplayName(this.router.url))
    );

    // Setup upload page detection
    this.isUploadPage$ = this.router.events.pipe(
      filter(event => event instanceof NavigationEnd),
      map((event: NavigationEnd) => event.url.includes('upload') || event.url === '/'),
      startWith(this.router.url.includes('upload') || this.router.url === '/')
    );

    // Setup theme tracking
    this.currentTheme$ = this.themeService.theme$;
  }
  
  ngOnInit(): void {
    this.initializeSystemMonitoring();
    this.setupKeyboardShortcuts();
    this.addWelcomeNotification();
  }
  
  ngOnDestroy(): void {
    this.destroy$.next();
    this.destroy$.complete();
  }
  
  // System monitoring initialization
  private initializeSystemMonitoring(): void {
    // Simulate memory usage monitoring
    interval(2000).pipe(
      takeUntil(this.destroy$)
    ).subscribe(() => {
      const usage = this.getMemoryUsage();
      this.memoryUsage$.next(usage);
    });
    
    // Monitor point cloud service for active clouds
    this.pointCloudService.getPointClouds().pipe(
      takeUntil(this.destroy$)
    ).subscribe((pointClouds: PointCloud[]) => {
      const active = pointClouds.filter((pc: PointCloud) => pc.status === 'completed').length;
      this.activePointClouds$.next(active);
      
      const processing = pointClouds.filter((pc: PointCloud) => pc.status === 'processing').length;
      this.processingQueue$.next(processing);
    });
    
    // Simulate connection monitoring
    interval(5000).pipe(
      takeUntil(this.destroy$)
    ).subscribe(() => {
      const isOnline = navigator.onLine;
      this.connectionStatus$.next(isOnline ? 'connected' : 'disconnected');
    });
  }
  
  // Memory usage simulation (would use actual Performance API in production)
  private getMemoryUsage(): number {
    if ('memory' in performance) {
      const memory = (performance as any).memory;
      return Math.round((memory.usedJSHeapSize / memory.jsHeapSizeLimit) * 100);
    }
    // Fallback simulation
    return Math.floor(Math.random() * 30) + 20; // 20-50% usage
  }
  
  // Route display name mapping
  private getRouteDisplayName(url: string): string {
    if (url === '/' || url.includes('point-clouds')) return 'Point Cloud Library';
    if (url.startsWith('/viewer')) return 'Point Cloud Viewer';
    return 'Point Cloud Viewer';
  }

  // Header action methods
  navigateToUpload(): void {
    this.router.navigate(['/point-clouds']);
  }

  openUploadDialog(): void {
    this.router.navigate(['/point-clouds']);
    this.addNotification('info', 'Navigate to library to upload and view files');
  }
  
  openSettings(): void {
    this.addNotification('info', 'Settings panel will be implemented in next update');
  }
  
  openHelp(): void {
    this.addNotification('info', 'Opening help documentation...');
    window.open('https://github.com/your-repo/docs', '_blank');
  }
  
  @HostListener('document:fullscreenchange', [])
  onFullscreenChange(): void {
    this.isFullscreen = !!document.fullscreenElement;
  }
  
  toggleFullscreen(): void {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen();
    } else {
      document.exitFullscreen();
    }
  }
  
  // Notification management
  addNotification(type: SystemNotification['type'], message: string): void {
    const notification: SystemNotification = {
      id: Date.now().toString(),
      type,
      message,
      timestamp: new Date()
    };
    
    const current = this.notifications$.value;
    this.notifications$.next([notification, ...current].slice(0, 5)); // Keep only 5 notifications
    
    // Auto-dismiss info notifications after 5 seconds
    if (type === 'info') {
      setTimeout(() => {
        this.dismissNotification(notification.id);
      }, 5000);
    }
  }
  
  dismissNotification(id: string): void {
    const current = this.notifications$.value;
    this.notifications$.next(current.filter(n => n.id !== id));
  }
  
  clearNotifications(): void {
    this.notifications$.next([]);
  }
  
  getNotificationIcon(type: SystemNotification['type']): string {
    switch (type) {
      case 'info': return 'info';
      case 'warning': return 'warning';
      case 'error': return 'error';
      case 'success': return 'check_circle';
      default: return 'info';
    }
  }
  
  // Keyboard shortcuts setup
  @HostListener('document:keydown', ['$event'])
  handleKeyboardShortcut(event: KeyboardEvent): void {
    if (event.ctrlKey || event.metaKey) {
      switch (event.key) {
        case 'h':
          event.preventDefault();
          this.router.navigate(['/point-clouds']);
          break;
        case 'f':
          event.preventDefault();
          this.toggleFullscreen();
          break;
        case 'u':
          event.preventDefault();
          this.openUploadDialog();
          break;
      }
    }
    
    // Escape key handling
    if (event.key === 'Escape' && this.isFullscreen) {
      this.toggleFullscreen();
    }
  }
  
  private setupKeyboardShortcuts(): void {
    this.addNotification('info', 'Keyboard shortcuts: Ctrl+H (Home), Ctrl+F (Fullscreen), Ctrl+U (Upload)');
  }
  
  private addWelcomeNotification(): void {
    setTimeout(() => {
      this.addNotification('success', 'Welcome to Point Cloud Viewer! System initialized successfully.');
    }, 1000);
  }

  // Theme management
  toggleTheme(): void {
    this.themeService.cycleTheme();
    const currentTheme = this.themeService.getCurrentTheme();
    this.addNotification('info', `Theme switched to ${currentTheme} mode`);
  }

  getThemeIcon(theme: Theme | null): string {
    if (!theme) return 'brightness_auto';
    switch (theme) {
      case 'light':
        return 'light_mode';
      case 'dark':
        return 'dark_mode';
      case 'auto':
        return 'brightness_auto';
      default:
        return 'brightness_auto';
    }
  }

  getThemeLabel(theme: Theme | null): string {
    if (!theme) return 'Auto Mode';
    switch (theme) {
      case 'light':
        return 'Light Mode';
      case 'dark':
        return 'Dark Mode';
      case 'auto':
        return 'Auto Mode';
      default:
        return 'Auto Mode';
    }
  }

  // TrackBy function for notifications
  trackNotification(index: number, notification: SystemNotification): string {
    return notification.id;
  }
}
