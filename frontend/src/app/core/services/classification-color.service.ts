import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { BehaviorSubject, Observable } from 'rxjs';
import { map, tap } from 'rxjs/operators';
import { ApiService } from './api.service';

export interface ClassificationColorScheme {
  classification_value: number;
  name: string;
  color: string;
  auto_generated: boolean;
}

@Injectable({
  providedIn: 'root'
})
export class ClassificationColorService {
  private apiUrl: string;
  private colorSchemesSubject = new BehaviorSubject<ClassificationColorScheme[]>([]);
  public colorSchemes$ = this.colorSchemesSubject.asObservable();

  constructor(private http: HttpClient, private apiService: ApiService) {
    // Use the same API base as the rest of the app to avoid relative-path 404s
    this.apiUrl = `${this.apiService.getApiUrl()}/classification-colors`;
  }

  /**
   * Load all classification color schemes from the backend
   */
  loadAllColorSchemes(): Observable<ClassificationColorScheme[]> {
    return this.http.get<ClassificationColorScheme[]>(this.apiUrl).pipe(
      tap(schemes => {
        this.colorSchemesSubject.next(schemes);
        console.log(`✅ Loaded ${schemes.length} classification color schemes`);
      })
    );
  }

  /**
   * Load color schemes for classifications that exist in a specific point cloud
   */
  loadPointCloudColorSchemes(pointcloudId: number): Observable<ClassificationColorScheme[]> {
    return this.http.get<ClassificationColorScheme[]>(
      `${this.apiUrl}/pointcloud/${pointcloudId}`
    ).pipe(
      tap(schemes => {
        console.log(`✅ Loaded ${schemes.length} classification schemes for point cloud ${pointcloudId}`);
      })
    );
  }

  /**
   * Update the color for a specific classification (globally)
   */
  updateColor(classificationValue: number, color: string): Observable<any> {
    return this.http.patch(
      `${this.apiUrl}/${classificationValue}`,
      { color }
    ).pipe(
      tap(() => {
        // Update local cache
        const schemes = this.colorSchemesSubject.value;
        const updated = schemes.map(s =>
          s.classification_value === classificationValue
            ? { ...s, color, auto_generated: false }
            : s
        );
        this.colorSchemesSubject.next(updated);
        console.log(`✅ Updated color for classification ${classificationValue} to ${color}`);
      })
    );
  }

  /**
   * Get color map as a Record<number, string> for easy lookup
   */
  getColorMap(): Record<number, string> {
    const schemes = this.colorSchemesSubject.value;
    return schemes.reduce((map, scheme) => {
      map[scheme.classification_value] = scheme.color;
      return map;
    }, {} as Record<number, string>);
  }

  /**
   * Get the current color schemes array
   */
  getCurrentSchemes(): ClassificationColorScheme[] {
    return this.colorSchemesSubject.value;
  }
}
