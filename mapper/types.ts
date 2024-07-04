import type { OpenAPI } from 'openapi-types';

export type Api = {
  id: string;
  name: string;
  baseUrl: string;
  accessToken: string;
  parameterSubstitutions: {
    name: string;
    value: string;
  }[];
  endpoints: Endpoint[];
  schemas: Schema[];
  rawApiSpec: OpenAPI.Document;
};

export type Endpoint = {
  name: string;
  description?: string;
  path: string;
  method: string;
  parameters: Field[];
  responseSchema: Schema;
};

export type Schema = {
  name: string;
  description?: string;
  fields: Field[];
};

export type Field = {
  name: string;
  description?: string;
  //   type: string | Schema;
};

export type MappingPart = {
  api: Api;
  getAll?: Endpoint;
  getOne?: Endpoint;
  create?: Endpoint;
  update?: Endpoint;
  delete?: Endpoint;
  fieldMapping: Record<string, string>;
};

export type Mapping = {
  id: string;
  name: string;
  parts: MappingPart[];
};

export type SuggestedMapping = {
  [key: string]: {
    [app: string]: {
      getAll: string;
      getOne: string;
      create: string;
      update: string;
      delete: string;
    };
  };
};
