import { Injectable } from '@angular/core';
import { BehaviorSubject } from 'rxjs';

export type Theme = 'light' | 'dark' | 'auto';

@Injectable({
  providedIn: 'root'
})
export class ThemeService {
  private currentTheme = new BehaviorSubject<Theme>('auto');
  public theme$ = this.currentTheme.asObservable();

  constructor() {
    this.loadTheme();
  }

  setTheme(theme: Theme): void {
    this.currentTheme.next(theme);
    this.saveTheme(theme);
    this.applyTheme(theme);
  }

  getCurrentTheme(): Theme {
    return this.currentTheme.value;
  }

  cycleTheme(): void {
    const current = this.getCurrentTheme();
    let next: Theme;

    switch (current) {
      case 'light':
        next = 'dark';
        break;
      case 'dark':
        next = 'auto';
        break;
      case 'auto':
      default:
        next = 'light';
        break;
    }

    this.setTheme(next);
  }

  private loadTheme(): void {
    const savedTheme = localStorage.getItem('theme') as Theme || 'auto';
    this.currentTheme.next(savedTheme);
    this.applyTheme(savedTheme);
  }

  private saveTheme(theme: Theme): void {
    localStorage.setItem('theme', theme);
  }

  private applyTheme(theme: Theme): void {
    const root = document.documentElement;

    if (theme === 'auto') {
      // Use system preference
      const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
      root.classList.toggle('dark-theme', prefersDark);
    } else {
      root.classList.toggle('dark-theme', theme === 'dark');
    }
  }
}