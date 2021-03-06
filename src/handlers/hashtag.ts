// TODO: cleanup
/* eslint-disable @typescript-eslint/ban-ts-comment */

import {
    ExtraAudio,
    ExtraDocument,
    ExtraPhoto,
    ExtraReplyMessage,
    ExtraVideo,
    MessageEntity,
    Message as TMessage,
} from 'telegraf/typings/telegram-types';
import { Group as IGroup, Message as IMessage } from '../typings/db';
import { TBot, TContext } from '../typings';
import Channel from '../models/channel';
import Group from '../models/group';
import Message from '../models/message';
import commentMiddleware from '../middleware/createComment';
import countLikes from '../middleware/countLikes';
import formatLikeKeyboard from '../middleware/formatLikeKeyboard';
import textToHtml from '@youtwitface/text-to-html';

export default (bot: TBot): void => {
    const getReplyMarkup = ({
        chat,
        directLink,
        message_id,
        plus = 0,
        minus = 0,
    }: {
        chat: IGroup;
        directLink: string;
        message_id: number;
        plus?: number;
        minus?: number;
    }): ExtraReplyMessage['reply_markup'] => {
        const inlineKeyboard = [];

        if (chat.settings?.likes) {
            inlineKeyboard.push(formatLikeKeyboard(plus, minus));
        }

        if (chat.settings?.link) {
            inlineKeyboard.push([
                {
                    text: 'Go to message',
                    url: `https://t.me/${directLink}/${message_id}`,
                },
            ]);
        }

        return {
            // TODO:
            // @ts-ignore
            inline_keyboard: inlineKeyboard,
        };
    };

    const getMessage = (ctx: TContext) => {
        const message = (ctx.message || ctx.editedMessage)!;
        const { forward_date, reply_to_message: reply } = message;

        // Use `forward_date` because it's always there for every type of forward
        if (forward_date) return;

        let entities = message.entities || message.caption_entities || [];
        let text = message.text || message.caption || '';

        const hashtagEntities = entities.filter(
            entity => entity.type === 'hashtag',
        );

        const tags = hashtagEntities
            .filter(entity => entity.type === 'hashtag')
            .map(entity =>
                text
                    .slice(entity.offset + 1, entity.offset + entity.length)
                    .toLowerCase(),
            );

        const untaggedText = hashtagEntities
            .reduce(
                (res, entity) =>
                    res.slice(0, entity.offset) +
                    res.slice(entity.offset + entity.length),
                text,
            )
            .trim();

        const messageToSend = untaggedText !== '' || !reply ? message : reply;
        text = messageToSend.text || messageToSend.caption || '';
        entities =
            messageToSend.entities || messageToSend.caption_entities || [];

        return {
            message: messageToSend,
            text,
            entities,
            tags,
        };
    };

    const sendMessage = async (
        ctx: TContext,
        chat: IGroup,
        channelID: number,
        message: TMessage,
        text: string,
        entities: MessageEntity[],
    ) => {
        // Use `!== false` in case it's `undefined`
        if (!chat.settings || chat.settings.forwards !== false) {
            return await ctx.telegram.forwardMessage(
                channelID,
                ctx.chat!.id,
                message.message_id,
            );
        }

        const channel = await Channel.findOne({ chat_id: channelID });
        const parsedMessage: string = textToHtml(text, entities);
        const chatId = ctx.chat!.id.toString().slice(4);
        const directLink = ctx.chat!.username || `c/${chatId}`;

        const options: ExtraAudio | ExtraDocument | ExtraPhoto | ExtraVideo = {
            reply_markup: getReplyMarkup({
                chat,
                directLink,
                message_id: message.message_id,
            }),
            caption: parsedMessage,
            parse_mode: 'HTML',
        };

        let sentMessage;

        if (message.audio) {
            sentMessage = await ctx.telegram.sendAudio(
                channelID,
                message.audio.file_id,
                options,
            );
        } else if (message.document) {
            sentMessage = await ctx.telegram.sendDocument(
                channelID,
                message.document.file_id,
                options,
            );
        } else if (message.photo) {
            if (chat.settings.comments) {
                await ctx.createComment!(
                    parsedMessage,
                    channel?.admins || [],
                    options,
                );
            }

            const photos = [...message.photo];
            const fileId = photos.pop()!.file_id;

            sentMessage = await ctx.telegram.sendPhoto(
                channelID,
                fileId,
                options,
            );
        } else if (message.video) {
            sentMessage = await ctx.telegram.sendVideo(
                channelID,
                message.video.file_id,
                options,
            );
        } else {
            if (chat.settings.comments) {
                await ctx.createComment!(
                    parsedMessage,
                    channel?.admins || [],
                    options,
                );
            }

            sentMessage = await ctx.telegram.sendMessage(
                channelID,
                parsedMessage,
                options,
            );
        }

        return sentMessage;
    };

    const handler = async (ctx: TContext) => {
        if (!ctx.chat!.type.includes('group')) return;

        const _message = getMessage(ctx);
        if (!_message) return;

        const { message, text, entities, tags } = _message;

        let chat: IGroup | null;
        try {
            chat = await Group.findOne({ chat_id: ctx.chat!.id });
        } catch (err) {
            console.error(err);
            return;
        }

        if (!chat || !chat.tags) return;

        const sentChannels: number[] = [];

        for (const tag of tags) {
            if (!chat.tags[tag]) {
                continue;
            }

            // Convert to array for backwards compatibility
            if (!Array.isArray(chat.tags[tag])) {
                // @ts-ignore
                chat.tags[tag] = [chat.tags[tag]];
            }

            for (const channel of chat.tags[tag]) {
                if (sentChannels.includes(channel)) {
                    continue;
                }

                const sentMessage = await sendMessage(
                    ctx,
                    chat,
                    channel,
                    message,
                    text,
                    entities,
                );

                sentChannels.push(channel);
                await new Message({
                    chat_id: ctx.chat!.id,
                    message_id: message.message_id,
                    channel_id: channel,
                    channel_message_id: sentMessage.message_id,
                }).save();
            }
        }
    };

    // @ts-ignore telegraf's types is missing Composer.entity
    bot.entity('hashtag', commentMiddleware, handler);

    bot.on('edited_message', async (ctx, next) => {
        if (!ctx.chat!.type.includes('group')) return;

        const editedMessage = ctx.editedMessage!;
        const { message, text, entities } = getMessage(ctx)!;
        const { id: chat_id } = editedMessage.chat;

        let channelMessages: IMessage[] | null;
        try {
            channelMessages = await Message.find({
                chat_id,
                message_id: message.message_id,
            });
        } catch (err) {
            console.error(err);
            return;
        }

        if (!channelMessages.length) {
            const entities =
                editedMessage.entities || editedMessage.caption_entities || [];

            if (entities.some(entity => entity.type === 'hashtag')) {
                commentMiddleware(ctx, next);
                await handler(ctx);
            }

            return;
        }

        let chat: IGroup | null;
        try {
            chat = await Group.findOne({ chat_id });
        } catch (err) {
            console.error(err);
            return;
        }

        if (!chat) {
            return;
        }

        for (const channelMessage of channelMessages) {
            // Use `!== false` in case it's `undefined`
            if (!chat.settings || chat.settings.forwards !== false) {
                ctx.telegram.forwardMessage(
                    channelMessage.channel_id,
                    chat_id,
                    message.message_id,
                );

                ctx.telegram
                    .deleteMessage(
                        channelMessage.channel_id,
                        channelMessage.channel_message_id,
                    )
                    .catch(() => {
                        // Ignore error
                    });

                continue;
            }

            const parsedMessage: string = textToHtml(text, entities);
            const chatId = ctx.chat!.id.toString().slice(4);
            const directLink = ctx.chat!.username || `c/${chatId}`;

            const [plus, minus] = await countLikes(
                chat_id,
                channelMessage.channel_message_id,
            );
            const messageOptions = {
                reply_markup: getReplyMarkup({
                    chat,
                    directLink,
                    message_id: message.message_id,
                    plus,
                    minus,
                }),
                parse_mode: 'html',
            };

            let messagePromise: Promise<
                TMessage | boolean | void
            > = Promise.resolve();
            if (
                message.audio ||
                message.document ||
                message.photo ||
                message.video
            ) {
                messagePromise = ctx.telegram.editMessageCaption(
                    channelMessage.channel_id,
                    channelMessage.channel_message_id,
                    undefined,
                    parsedMessage,
                    // @ts-ignore
                    messageOptions,
                );
            } else {
                messagePromise = ctx.telegram.editMessageText(
                    channelMessage.channel_id,
                    channelMessage.channel_message_id,
                    undefined,
                    parsedMessage,
                    // @ts-ignore
                    messageOptions,
                );
            }

            messagePromise.catch(async err => {
                if (
                    err.description === 'Bad Request: message to edit not found'
                ) {
                    commentMiddleware(ctx, next);

                    const sentMessage = await sendMessage(
                        ctx,
                        // TODO: figure out why TypeScript is complaining
                        chat!,
                        channelMessage.channel_id,
                        message,
                        parsedMessage,
                        [],
                    );

                    await new Message({
                        chat_id: ctx.chat!.id,
                        message_id: message.message_id,
                        channel_id: channelMessage.channel_id,
                        channel_message_id: sentMessage.message_id,
                    }).save();
                } else {
                    console.log(err);
                }
            });
        }
    });
};
