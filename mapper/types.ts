export type Api = {
  name: string;
  baseUrl: string;
  accessToken: string;
  endpoints: Endpoint[];
  schemas: Schema[];
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
  type: string | Schema;
};

type MappingPart = {
  api: Api;
  getAll: string;
  getOne: string;
  create: string;
  update: string;
  delete: string;
  fieldMapping: Record<string, string>;
};

export type Mapping = {
  name: string;
  parts: MappingPart[];
};
