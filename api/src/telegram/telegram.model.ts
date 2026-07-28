import { Field, Int, ObjectType } from '@nestjs/graphql';

@ObjectType()
export class ManagedTelegramBotModel {
  @Field() available!: boolean;
  @Field(() => String, { nullable: true }) username!: string | null;
}

@ObjectType()
export class TelegramConnectionPreviewModel {
  @Field() chatId!: string;
  @Field() chatType!: string;
  @Field(() => String, { nullable: true }) chatTitle!: string | null;
  @Field(() => Int, { nullable: true }) messageThreadId!: number | null;
  @Field() expiresAt!: Date;
}
