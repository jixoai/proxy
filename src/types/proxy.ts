export interface ProxyForwardHeaders {
  [key: string]: string;
}

export interface ProxyForwardConfig {
  name: string;
  enabled: boolean;
  target: string;
  description: string | null;
  path: string | null;
  methods: string[];
  headers: ProxyForwardHeaders | null;
}

export interface ProxyInstanceConfig {
  name: string;
  port: number;
  enabled: boolean;
  description: string | null;
  headers: ProxyForwardHeaders | null;
  forwards: ProxyForwardConfig[];
}

export interface ProxyConfigFile {
  instances: ProxyInstanceConfig[];
}

export interface ProxyForward {
  id?: number;
  instance_id?: number;
  name: string;
  enabled: boolean;
  target_url: string;
  description: string | null;
  path: string | null;
  method: string;
  custom_headers: string | null;
}

export interface ProxyInstance {
  id?: number;
  name: string;
  port: number;
  enabled: boolean;
  description: string | null;
  instance_headers: string | null;
}
