import { Validations } from 'aws-cdk-lib';
import type { IConstruct } from 'constructs';

/** Acknowledge cdk-nag findings on a construct (and its children) with a recorded reason. */
export function acknowledge(scope: IConstruct, items: { id: string; reason: string }[]): void {
  for (const i of items) Validations.of(scope).acknowledge(i);
}
