import { Resource } from 'alchemy';
import * as Provider from 'alchemy/Provider';
import * as Effect from 'effect/Effect';
import { ManagementClient } from '../client.ts';
import { call, callOptional, callVoid } from '../http.ts';

export interface ProjectProps {
  /** The workspace that will own this project. */
  workspaceId: string;
  /** Human-readable project name. */
  name: string;
}

export interface ProjectAttributes {
  id: string;
  name: string;
}

export type Project = Resource<'Prisma.Project', ProjectProps, ProjectAttributes>;

/** A Prisma Developer Platform **Project** — the container for databases and compute services. */
export const Project = Resource<Project>('Prisma.Project');

export const ProjectProvider = () =>
  Provider.effect(
    Project,
    Effect.gen(function* () {
      const client = yield* ManagementClient;

      return {
        stables: ['id'],
        list: () => Effect.succeed([] as ProjectAttributes[]),
        reconcile: Effect.fn(function* ({ news, output }) {
          // Observe — a project is only findable by its saved id.
          const observed = output?.id
            ? yield* callOptional(() =>
                client.GET('/v1/projects/{id}', {
                  params: { path: { id: output.id } },
                }),
              )
            : undefined;
          if (observed) return { id: observed.data.id, name: observed.data.name };

          // Ensure — create it in the target workspace.
          const created = yield* call(() =>
            client.POST('/v1/projects', {
              body: { name: news.name, workspaceId: news.workspaceId },
            }),
          );
          return { id: created.data.id, name: created.data.name };
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* callVoid(() =>
            client.DELETE('/v1/projects/{id}', {
              params: { path: { id: output.id } },
            }),
          );
        }),
        read: Effect.fn(function* ({ output }) {
          if (!output?.id) return undefined;
          const p = yield* callOptional(() =>
            client.GET('/v1/projects/{id}', {
              params: { path: { id: output.id } },
            }),
          );
          return p ? { id: p.data.id, name: p.data.name } : undefined;
        }),
      };
    }),
  );
