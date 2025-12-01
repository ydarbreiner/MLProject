import { Component, Output, EventEmitter, ChangeDetectionStrategy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { MatMenuModule } from '@angular/material/menu';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { MatDividerModule } from '@angular/material/divider';
import { MenuService, Menu, MenuItem } from '../../../core/services/menu.service';

@Component({
  selector: 'app-menu-bar',
  standalone: true,
  imports: [
    CommonModule,
    MatMenuModule,
    MatIconModule,
    MatButtonModule,
    MatDividerModule
  ],
  templateUrl: './menu-bar.component.html',
  styleUrls: ['./menu-bar.component.scss']
})
export class MenuBarComponent {
  // Event outputs for actions that need to be handled by parent component
  @Output() undoRequested = new EventEmitter<void>();
  @Output() redoRequested = new EventEmitter<void>();
  @Output() colorModeChanged = new EventEmitter<string>();
  @Output() toolSelected = new EventEmitter<string>();
  @Output() fullscreenToggled = new EventEmitter<void>();
  @Output() classificationEditorToggled = new EventEmitter<void>();

  // Track current submenu items for dynamic submenu rendering
  currentSubmenuItems: MenuItem[] | null = null;

  constructor(public menuService: MenuService) {
    // Menus are retrieved dynamically from service
  }

  get menus(): Menu[] {
    return this.menuService.getAllMenus();
  }

  executeMenuItem(item: MenuItem): void {
    if (item.disabled) {
      return;
    }

    if (item.action) {
      item.action();
    }
  }

  hasSubmenu(item: MenuItem): boolean {
    return !!(item.submenu && item.submenu.length > 0);
  }

  setCurrentSubmenu(item: MenuItem): void {
    this.currentSubmenuItems = item.submenu || null;
  }

  trackByLabel(index: number, item: MenuItem): string {
    return item.label || `item-${index}`;
  }
}
