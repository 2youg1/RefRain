/** Renderer wire intent; Revision and readable context are absent because main owns both. */
export interface ReviewTaskIntent {
  readonly id: string;
  readonly agentId: string;
  readonly chapter: string;
  readonly prompt: string;
  readonly editScopes: readonly {
    readonly id: string;
    readonly blockIds: readonly string[];
    readonly text: string;
  }[];
}
