export interface ActiveStreamJob {
  stream_id: string;
  session_id: string;
  needs_input?: boolean;
  /** Present only for nested Task/Swarm child jobs. */
  parent_session_id?: string;
}

export function isChildStreamJob(job: ActiveStreamJob): boolean {
  return !!job.parent_session_id;
}

/** Root tasks stay hydrated globally; child streams attach when inspected. */
export function shouldHydrateStreamJob(job: ActiveStreamJob): boolean {
  return !isChildStreamJob(job);
}
