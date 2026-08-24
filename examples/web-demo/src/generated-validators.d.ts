export interface StandaloneValidationError {
  instancePath: string;
  schemaPath: string;
  keyword: string;
  params: Record<string, unknown>;
  message?: string;
}

export interface StandaloneValidateFunction<T> {
  (value: unknown): value is T;
  errors?: StandaloneValidationError[] | null;
}

export const validateRuntime: StandaloneValidateFunction<unknown>;
export const validateManifest: StandaloneValidateFunction<unknown>;
