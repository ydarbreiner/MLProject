import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable, firstValueFrom } from 'rxjs';

export interface MeasurementPoint {
  x: number;
  y: number;
  z: number;
}

export interface Measurement {
  id: number;
  pointcloudId: number;
  point1: MeasurementPoint;
  point2: MeasurementPoint;
  distance: number;
  label?: string;
  metadata?: any;
  createdAt?: string;
  updatedAt?: string;
}

export interface CreateMeasurementRequest {
  point1: MeasurementPoint;
  point2: MeasurementPoint;
  distance: number;
  label?: string;
  metadata?: any;
}

@Injectable({
  providedIn: 'root'
})
export class MeasurementService {
  private readonly apiUrl = 'http://localhost:8000/api';

  constructor(private http: HttpClient) {}

  getMeasurements(pointcloudId: number): Observable<Measurement[]> {
    return this.http.get<Measurement[]>(`${this.apiUrl}/pointclouds/${pointcloudId}/measurements`);
  }

  async getMeasurementsAsync(pointcloudId: number): Promise<Measurement[]> {
    return firstValueFrom(this.getMeasurements(pointcloudId));
  }

  createMeasurement(pointcloudId: number, data: CreateMeasurementRequest): Observable<Measurement> {
    return this.http.post<Measurement>(`${this.apiUrl}/pointclouds/${pointcloudId}/measurements`, data);
  }

  async createMeasurementAsync(pointcloudId: number, data: CreateMeasurementRequest): Promise<Measurement> {
    return firstValueFrom(this.createMeasurement(pointcloudId, data));
  }

  updateMeasurement(pointcloudId: number, measurementId: number, data: { label?: string; metadata?: any }): Observable<Measurement> {
    return this.http.patch<Measurement>(`${this.apiUrl}/pointclouds/${pointcloudId}/measurements/${measurementId}`, data);
  }

  async updateMeasurementAsync(pointcloudId: number, measurementId: number, data: { label?: string; metadata?: any }): Promise<Measurement> {
    return firstValueFrom(this.updateMeasurement(pointcloudId, measurementId, data));
  }

  deleteMeasurement(pointcloudId: number, measurementId: number): Observable<void> {
    return this.http.delete<void>(`${this.apiUrl}/pointclouds/${pointcloudId}/measurements/${measurementId}`);
  }

  async deleteMeasurementAsync(pointcloudId: number, measurementId: number): Promise<void> {
    return firstValueFrom(this.deleteMeasurement(pointcloudId, measurementId));
  }

  deleteAllMeasurements(pointcloudId: number): Observable<void> {
    return this.http.delete<void>(`${this.apiUrl}/pointclouds/${pointcloudId}/measurements`);
  }

  async deleteAllMeasurementsAsync(pointcloudId: number): Promise<void> {
    return firstValueFrom(this.deleteAllMeasurements(pointcloudId));
  }
}
