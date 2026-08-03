import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { Project, Spec, UNGROUPED_PROJECT } from './types';
import { PROJECTS_DIR, ensureDirs } from './config';

export interface ProjectGroup {
  project: Project;
  specs: Spec[];
}

function projectToYaml(p: Project): Record<string, unknown> {
  return { name: p.name, description: p.description, features: p.features, created_at: p.createdAt };
}

function yamlToProject(raw: Record<string, unknown>): Project {
  return {
    name: raw['name'] as string,
    description: (raw['description'] as string) || undefined,
    features: (raw['features'] as string[]) || [],
    createdAt: (raw['created_at'] as string) || new Date().toISOString(),
  };
}

export function saveProject(p: Project): void {
  ensureDirs();
  const filePath = path.join(PROJECTS_DIR, `${p.name}.yaml`);
  fs.writeFileSync(filePath, yaml.dump(projectToYaml(p), { lineWidth: -1 }), 'utf-8');
}

export function loadProject(name: string): Project | undefined {
  ensureDirs();
  const filePath = path.join(PROJECTS_DIR, `${name}.yaml`);
  if (!fs.existsSync(filePath)) { return undefined; }
  const raw = yaml.load(fs.readFileSync(filePath, 'utf-8')) as Record<string, unknown>;
  return yamlToProject(raw);
}

export function listProjects(): Project[] {
  ensureDirs();
  if (!fs.existsSync(PROJECTS_DIR)) { return []; }
  return fs.readdirSync(PROJECTS_DIR)
    .filter(f => f.endsWith('.yaml'))
    .map(f => loadProject(path.basename(f, '.yaml')))
    .filter((p): p is Project => !!p);
}

export function deleteProject(name: string): void {
  const filePath = path.join(PROJECTS_DIR, `${name}.yaml`);
  if (fs.existsSync(filePath)) { fs.unlinkSync(filePath); }
}

/**
 * Group specs under their projects. Specs whose projectName is absent or points
 * to a non-existent project fall into a virtual Ungrouped group (not persisted).
 * The Ungrouped group is only present when it has at least one spec.
 */
export function groupSpecsByProject(specs: Spec[], projects: Project[]): ProjectGroup[] {
  const byName = new Map<string, ProjectGroup>();
  for (const p of projects) {
    byName.set(p.name, { project: p, specs: [] });
  }
  const ungrouped: Spec[] = [];
  for (const s of specs) {
    const g = s.projectName ? byName.get(s.projectName) : undefined;
    if (g) { g.specs.push(s); } else { ungrouped.push(s); }
  }
  const groups: ProjectGroup[] = [...byName.values()];
  if (ungrouped.length > 0) {
    groups.push({
      project: { name: UNGROUPED_PROJECT, features: [], createdAt: '' },
      specs: ungrouped,
    });
  }
  return groups;
}
