import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { Spec } from './types';
import { SPECS_DIR, ensureDirs } from './config';

export function saveSpec(spec: Spec): void {
  ensureDirs();
  const filePath = path.join(SPECS_DIR, `${spec.name}.yaml`);
  const content = yaml.dump(specToYaml(spec), { lineWidth: -1 });
  fs.writeFileSync(filePath, content, 'utf-8');
}

export function loadSpec(name: string): Spec | undefined {
  ensureDirs();
  const filePath = path.join(SPECS_DIR, `${name}.yaml`);
  if (!fs.existsSync(filePath)) {
    return undefined;
  }
  const content = fs.readFileSync(filePath, 'utf-8');
  const raw = yaml.load(content) as Record<string, unknown>;
  return yamlToSpec(raw);
}

export function listSpecs(): Spec[] {
  ensureDirs();
  if (!fs.existsSync(SPECS_DIR)) {
    return [];
  }
  const files = fs.readdirSync(SPECS_DIR).filter(f => f.endsWith('.yaml'));
  const specs: Spec[] = [];
  for (const file of files) {
    const name = path.basename(file, '.yaml');
    const spec = loadSpec(name);
    if (spec) {
      specs.push(spec);
    }
  }
  return specs;
}

export function deleteSpec(name: string): void {
  const filePath = path.join(SPECS_DIR, `${name}.yaml`);
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }
}

// Convert Spec to YAML-friendly object (camelCase → snake_case)
function specToYaml(spec: Spec): Record<string, unknown> {
  return {
    name: spec.name,
    description: spec.description,
    feature_branch: spec.featureBranch,
    status: spec.status,
    agent_command: spec.agentCommand,
    repos: spec.repos.map(r => ({
      name: r.name,
      origin_path: r.originPath,
      worktree_path: r.worktreePath,
      branch: r.branch,
    })),
    created_at: spec.createdAt,
  };
}

// Convert YAML object to Spec (snake_case → camelCase)
function yamlToSpec(raw: Record<string, unknown>): Spec {
  const repos = (raw['repos'] as Array<Record<string, string>> || []).map(r => ({
    name: r['name'],
    originPath: r['origin_path'],
    worktreePath: r['worktree_path'],
    branch: r['branch'],
  }));
  return {
    name: raw['name'] as string,
    description: (raw['description'] as string) || '',
    featureBranch: raw['feature_branch'] as string,
    status: (raw['status'] as Spec['status']) || 'draft',
    agentCommand: (raw['agent_command'] as string) || 'ducc',
    repos,
    createdAt: (raw['created_at'] as string) || new Date().toISOString(),
  };
}
