/**
 * The page's one door to Foldkit's view layer. Components import their view builder, Messages, Commands, Mounts and
 * the Submodel plumbing from here, never from `foldkit` directly; `App.ts` and `entry.ts` add the runtime. Each export
 * has an Effect UI counterpart (see the header of `App.ts`), so moving back is a change to this file and the views.
 */
import { Option, Schema } from "effect";
import { Command, Dom, Mount, Update } from "foldkit";
import type { Attribute, Html, HtmlBuilder, TextareaAttribute } from "foldkit/html";
import { defineMessageUnion } from "foldkit/message";
import { defineTaggedUnion, taggedStruct } from "foldkit/schema";
import { defineView } from "foldkit/submodel";

export { Command, Dom, Mount, Option, Update, defineView };
export type { Html };

/** A view's element builder, typed by the Messages its handlers send. */
export type H<M> = HtmlBuilder<M>;

/** A tagged union of Messages (or events) as one Schema with a callable constructor per tag. */
export const TaggedEnum = defineMessageUnion;

/** A tagged union of values that are not Messages (what is open over the page, say), with the same constructors. */
export const TaggedUnion = defineTaggedUnion;

/** What a component's update returns: its next Model, the Commands to run and, at most, one event for its parent. */
export type Step<Model, Message, Event = never> = Update.ReturnWithOutMessage<Model, Message, Event, any>;

/** A Model unchanged, with Commands to run. */
export const run = <Model, Message>(model: Model, ...commands: ReadonlyArray<Command.Command<Message, never, any>>) => ({ model, commands });

/** A Model, with an event for the parent. */
export const emit = <Model, Event>(model: Model, outMessage: Event) => ({ model, outMessage });

type Part<M> = Attribute<M> | false | null | undefined;
type Kid = Html | string | false | null | undefined;

/**
 * One element as the page writes it: its classes (falsy ones dropped), its plain attributes (an undefined value
 * leaves the attribute out), its handlers and other typed attributes, and its children (false, null and undefined
 * dropped).
 */
export const el = <M>(
  h: H<M>,
  tag: "a" | "article" | "b" | "button" | "code" | "dd" | "defs" | "del" | "details" | "dialog" | "div" | "dl" | "dt" | "em" | "figcaption" | "figure" | "footer" | "form" | "g" | "h1" | "h2" | "h3" | "h4" | "header" | "i" | "img" | "input" | "ins" | "kbd" | "label" | "li" | "line" | "linearGradient" | "main" | "nav" | "ol" | "option" | "p" | "path" | "polygon" | "polyline" | "pre" | "rect" | "section" | "select" | "small" | "span" | "stop" | "summary" | "svg" | "table" | "tbody" | "td" | "text" | "textarea" | "th" | "thead" | "time" | "title" | "tr" | "ul" | "circle",
  spec: {
    readonly class?: ReadonlyArray<string | false | null | undefined> | string;
    readonly attrs?: Readonly<Record<string, string | undefined>>;
    readonly on?: ReadonlyArray<Part<M>>;
  } = {},
  ...children: ReadonlyArray<Kid>
): Html => {
  const parts: Array<Attribute<M>> = [];
  const classes = typeof spec.class === "string" ? spec.class : (spec.class ?? []).filter(Boolean).join(" ");
  if (classes) parts.push(h.Class(classes));
  for (const [key, value] of Object.entries(spec.attrs ?? {})) if (value !== undefined) parts.push(h.Attribute(key, value));
  for (const part of spec.on ?? []) if (part) parts.push(part);
  const kids = children.filter((kid): kid is Html | string => kid !== false && kid !== null && kid !== undefined);
  if (tag === "img" || tag === "input") return h[tag](parts);
  if (tag === "textarea") return h.textarea(parts.filter((part): part is TextareaAttribute<M> => part._tag !== "InnerHTML"));
  // Every other tag takes attributes and children alike.
  return h[tag as "div"](parts, kids);
};

/** The Message a Mount sends once the element it holds is set up; a component's update leaves its Model as it is. */
export const CompletedMount = taggedStruct("CompletedMount", { name: Schema.String });
export type CompletedMount = typeof CompletedMount.Type;
