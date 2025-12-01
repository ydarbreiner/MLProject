// Manual Emscripten type declarations
declare namespace Emscripten {
  interface Module {
    [key: string]: any;
  }
}

declare interface EmscriptenModule {
  [key: string]: any;
}

declare interface EmscriptenModuleFactory<T = EmscriptenModule> {
  (options?: any): Promise<T>;
}