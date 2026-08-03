import { expect } from 'chai';
import * as fs from 'fs';
import * as path from 'path';
import { PROJECTS_DIR } from '../config';
import { saveProject, loadProject, listProjects, deleteProject, groupSpecsByProject } from '../projectStore';
import { Spec, Project, UNGROUPED_PROJECT } from '../types';

function spec(name: string, projectName?: string): Spec {
  return { name, description: '', featureBranch: 'feat/x', status: 'active', agentCommand: 'ducc', repos: [], createdAt: '', projectName };
}

describe('projectStore', () => {
  afterEach(() => {
    for (const n of ['proj-a', 'proj-b']) {
      const f = path.join(PROJECTS_DIR, `${n}.yaml`);
      if (fs.existsSync(f)) { fs.unlinkSync(f); }
    }
  });

  it('saves and loads a project', () => {
    const p: Project = { name: 'proj-a', description: 'A', features: [], createdAt: new Date().toISOString() };
    saveProject(p);
    expect(loadProject('proj-a')?.description).to.equal('A');
    expect(listProjects().some(x => x.name === 'proj-a')).to.equal(true);
  });

  it('deleteProject removes the file', () => {
    saveProject({ name: 'proj-b', features: [], createdAt: '' });
    deleteProject('proj-b');
    expect(loadProject('proj-b')).to.equal(undefined);
  });

  it('groups specs by projectName, unknown/absent → Ungrouped', () => {
    const projects: Project[] = [{ name: 'proj-a', features: [], createdAt: '' }];
    const specs = [spec('s1', 'proj-a'), spec('s2'), spec('s3', 'ghost-project')];
    const groups = groupSpecsByProject(specs, projects);
    const a = groups.find(g => g.project.name === 'proj-a');
    const ung = groups.find(g => g.project.name === UNGROUPED_PROJECT);
    expect(a?.specs.map(s => s.name)).to.deep.equal(['s1']);
    expect(ung?.specs.map(s => s.name).sort()).to.deep.equal(['s2', 's3']);
  });

  it('omits Ungrouped group when all specs are grouped', () => {
    const projects: Project[] = [{ name: 'proj-a', features: [], createdAt: '' }];
    const groups = groupSpecsByProject([spec('s1', 'proj-a')], projects);
    expect(groups.some(g => g.project.name === UNGROUPED_PROJECT)).to.equal(false);
  });
});
