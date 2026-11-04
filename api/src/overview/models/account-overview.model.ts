import {
  Field,
  Float,
  ID,
  Int,
  ObjectType,
  registerEnumType,
} from '@nestjs/graphql';
import { CheckModel } from '../../checks/check.model';

export enum OverviewRange {
  DAY = 'DAY',
  WEEK = 'WEEK',
  MONTH = 'MONTH',
  QUARTER = 'QUARTER',
}
registerEnumType(OverviewRange, {
  name: 'OverviewRange',
  description: 'Reporting window ending now: 24h, 7d, 30d, or 90d.',
});

export enum BrokenState {
  DOWN = 'DOWN',
  LATE = 'LATE',
}
registerEnumType(BrokenState, { name: 'BrokenState' });

/** Organization identity only; never the creator or other members. */
@ObjectType()
export class OverviewOrganization {
  @Field(() => ID) id!: string;
  @Field() name!: string;
  @Field() slug!: string;
}

@ObjectType()
export class BrokenCheck {
  @Field(() => CheckModel) check!: CheckModel;
  @Field(() => OverviewOrganization) organization!: OverviewOrganization;
  @Field(() => BrokenState) state!: BrokenState;
  @Field({
    description: 'DOWN: when the open outage started. LATE: expected ping.',
  })
  since!: Date;
  @Field(() => Date, {
    nullable: true,
    description: 'LATE only: expected ping plus grace.',
  })
  downAt!: Date | null;
  @Field(() => String, {
    nullable: true,
    description: "DOWN active checks: the latest DOWN event's status or error.",
  })
  reason!: string | null;
}

@ObjectType()
export class OutageSpan {
  @Field() startedAt!: Date;
  @Field(() => Date, { nullable: true, description: 'Null while ongoing.' })
  endedAt!: Date | null;
}

@ObjectType()
export class CheckBrokenTime {
  @Field(() => CheckModel) check!: CheckModel;
  @Field(() => OverviewOrganization) organization!: OverviewOrganization;
  @Field(() => Float) brokenSeconds!: number;
  @Field(() => Int) outageCount!: number;
  @Field(() => Float) longestOutageSeconds!: number;
  @Field() ongoing!: boolean;
  @Field(() => Float, { nullable: true }) uptimePercent!: number | null;
  @Field(() => [OutageSpan], { description: 'Clipped to the range.' })
  outages!: OutageSpan[];
}

@ObjectType()
export class OverviewSummary {
  @Field(() => Float, { nullable: true }) uptimePercent!: number | null;
  @Field(() => Float) brokenSeconds!: number;
  @Field(() => Int) outageCount!: number;
  @Field(() => Int) ongoingCount!: number;
  @Field(() => Float, { nullable: true }) medianOutageSeconds!: number | null;
  @Field(() => CheckBrokenTime, { nullable: true })
  longestOutage!: CheckBrokenTime | null;
}

@ObjectType()
export class BrokenTimeBucket {
  @Field() start!: Date;
  @Field(() => Float) brokenSeconds!: number;
}

@ObjectType()
export class OrganizationBrokenTime {
  @Field(() => OverviewOrganization) organization!: OverviewOrganization;
  @Field(() => Float) brokenSeconds!: number;
  @Field(() => Int) outageCount!: number;
}

@ObjectType()
export class AccountOverview {
  @Field() rangeStart!: Date;
  @Field() rangeEnd!: Date;
  @Field(() => Int) organizationCount!: number;
  @Field(() => Int) checkCount!: number;
  @Field(() => [BrokenCheck]) needsFixing!: BrokenCheck[];
  @Field(() => OverviewSummary) summary!: OverviewSummary;
  @Field(() => [BrokenTimeBucket]) buckets!: BrokenTimeBucket[];
  @Field(() => [OrganizationBrokenTime])
  byOrganization!: OrganizationBrokenTime[];
  @Field(() => [CheckBrokenTime]) checks!: CheckBrokenTime[];
}
