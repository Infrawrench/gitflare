import { describe, expect, it } from 'vitest'
import {
  defineCI,
  isCIDefinition,
  planWaves,
  topoSort,
  type BuildContext,
  type Plan,
} from '../../packages/ci-config/src/index'

const context: BuildContext = {
  owner: 'astrid',
  repo: 'api',
  sha: 'a'.repeat(40),
  ref: 'refs/heads/main',
  branch: 'main',
  trigger: 'push',
  isDefaultBranch: true,
}

describe('defineCI', () => {
  it('records steps declaratively instead of executing them', () => {
    let sideEffects = 0
    const definition = defineCI(({ run }) => {
      sideEffects++
      run('install', 'bun install')
    })

    // Building is what runs the pipeline function; defining must not.
    expect(sideEffects).toBe(0)
    expect(isCIDefinition(definition)).toBe(true)

    const plan = definition.build(context)
    expect(sideEffects).toBe(1)
    expect(plan.steps).toEqual([
      { name: 'install', command: 'bun install', needs: [] },
    ])
  })

  it('derives dependencies from chaining', () => {
    const plan = defineCI(({ run, parallel }) => {
      const deps = run('install', 'bun install', { cache: ['bun.lock'] })
      return parallel(
        deps.run('lint', 'bun run lint'),
        deps.run('test', 'bun run test'),
      )
    }).build(context)

    expect(plan.steps.map((step) => [step.name, step.needs])).toEqual([
      ['install', []],
      ['lint', ['install']],
      ['test', ['install']],
    ])
    expect(plan.steps[0]!.cache).toEqual(['bun.lock'])
  })

  it('exposes the commit context to the pipeline', () => {
    const plan = defineCI(({ run, context: ctx }) => {
      if (ctx.isDefaultBranch) run('deploy', 'bun wrangler deploy')
    }).build(context)
    expect(plan.steps.map((step) => step.name)).toEqual(['deploy'])

    const featurePlan = defineCI(({ run, context: ctx }) => {
      if (ctx.isDefaultBranch) run('deploy', 'bun wrangler deploy')
    }).build({ ...context, isDefaultBranch: false, branch: 'feature' })
    expect(featurePlan.steps).toEqual([])
  })

  it('rejects duplicate step names', () => {
    // Workflow step names must be unique and deterministic; a duplicate would
    // make Workflows match a replayed step to the wrong result.
    expect(() =>
      defineCI(({ run }) => {
        run('build', 'a')
        run('build', 'b')
      }).build(context),
    ).toThrow(/Duplicate CI step name: build/)
  })

  it('rejects an empty step name', () => {
    expect(() => defineCI(({ run }) => run('  ', 'x')).build(context)).toThrow(/must not be empty/)
  })
})

describe('plan validation', () => {
  it('rejects a dependency on an unknown step', () => {
    const plan: Plan = {
      version: 1,
      steps: [{ name: 'test', command: 'x', needs: ['install'] }],
    }
    expect(() => topoSort(plan)).toThrow(/depends on unknown step "install"/)
  })

  it('rejects a dependency cycle rather than hanging at runtime', () => {
    const plan: Plan = {
      version: 1,
      steps: [
        { name: 'a', command: 'x', needs: ['b'] },
        { name: 'b', command: 'y', needs: ['a'] },
      ],
    }
    expect(() => topoSort(plan)).toThrow(/cycle/)
  })

  it('orders steps so dependencies come first', () => {
    const plan: Plan = {
      version: 1,
      steps: [
        { name: 'deploy', command: 'd', needs: ['test'] },
        { name: 'test', command: 't', needs: ['install'] },
        { name: 'install', command: 'i', needs: [] },
      ],
    }
    expect(topoSort(plan).map((step) => step.name)).toEqual(['install', 'test', 'deploy'])
  })
})

describe('planWaves', () => {
  it('groups independent steps into one concurrent wave', () => {
    const plan = defineCI(({ run, parallel }) => {
      const deps = run('install', 'bun install')
      parallel(
        deps.run('lint', 'lint'),
        deps.run('test', 'test'),
        deps.run('typecheck', 'tsc'),
      )
    }).build(context)

    const waves = planWaves(plan).map((wave) => wave.map((step) => step.name))
    expect(waves).toEqual([['install'], ['lint', 'test', 'typecheck']])
  })

  it('places a step after the deepest of its dependencies', () => {
    const plan: Plan = {
      version: 1,
      steps: [
        { name: 'install', command: 'i', needs: [] },
        { name: 'build', command: 'b', needs: ['install'] },
        // Depends on both a wave-0 and a wave-1 step, so it belongs in wave 2.
        { name: 'deploy', command: 'd', needs: ['install', 'build'] },
      ],
    }
    expect(planWaves(plan).map((wave) => wave.map((step) => step.name))).toEqual([
      ['install'],
      ['build'],
      ['deploy'],
    ])
  })
})
