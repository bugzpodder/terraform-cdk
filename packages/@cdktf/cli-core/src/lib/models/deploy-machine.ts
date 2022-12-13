import { createMachine, send, interpret, EventObject, assign } from "xstate";
import * as pty from "node-pty-prebuilt-multiarch";
import { Errors, logger } from "@cdktf/commons";

interface PtySpawnConfig {
  file: Parameters<typeof pty.spawn>[0];
  args: Parameters<typeof pty.spawn>[1];
  options: Parameters<typeof pty.spawn>[2];
}

interface DeployContext {
  exitCode?: number;
  /**
   * Terraform will exit with 1 if it was cancelled, but we don't want to fail in that case
   */
  cancelled?: boolean;
}

type DeployEvent =
  | { type: "START"; pty: PtySpawnConfig }
  | { type: "STOP" }
  | { type: "SEND_INPUT"; input: string }
  | { type: "LINE_RECEIVED"; line: string } //TODO: rename to output received as not really a line in practice
  | { type: "APPROVED_EXTERNALLY" } // e.g. via TFC UI or API
  | { type: "REJECTED_EXTERNALLY" }
  | { type: "REQUEST_APPROVAL" }
  | { type: "APPROVE" }
  | { type: "REJECT" }
  | { type: "EXITED"; exitCode: number };

export function isDeployEvent<DeployEventType extends DeployEvent["type"]>(
  event: EventObject,
  type: DeployEventType
): event is DeployEvent & { type: DeployEventType } {
  return event.type === type;
}

export type DeployState =
  | {
      value: "idle";
      context: DeployContext;
    }
  | {
      value: "running";
      context: DeployContext;
    }
  | {
      value: { running: "processing" };
      context: DeployContext;
    }
  | {
      value: { running: "awaiting_approval" };
      context: DeployContext;
    }
  | {
      value: "exited";
      context: DeployContext & { exitCode: number };
    }
  | {
      value: "stopped";
      context: DeployContext;
    };

export const deployMachine = createMachine<
  DeployContext,
  DeployEvent,
  DeployState
>({
  predictableActionArguments: true,
  context: {},
  initial: "idle",
  id: "root",
  states: {
    idle: {
      on: {
        START: { target: "running" },
      },
    },
    running: {
      invoke: {
        id: "pty",
        src: (_context, event) => (send, onReceive) => {
          if (event.type !== "START")
            throw Errors.Internal(
              `Terraform CLI invocation state machine: Unexpected event caused transition to the running state: ${event.type}`
            );
          const { file, args, options } = event.pty;
          logger.trace(
            `Spawning pty with file=${file}, args=${
              Array.isArray(args) ? `[${args.join(", ")}]` : `"${args}"`
            }, options=${JSON.stringify(options)}`
          );
          const p = pty.spawn(file, args, options);

          onReceive((event: DeployEvent) => {
            if (event.type === "SEND_INPUT") {
              p.write(event.input);
            }
          });

          p.onData((line) => {
            send({ type: "LINE_RECEIVED", line });

            // possible events based on line
            if (line.includes("approved using the UI or API")) {
              send({ type: "APPROVED_EXTERNALLY" });
            } else if (line.includes("discarded using the UI or API")) {
              send({ type: "REJECTED_EXTERNALLY" });
            } else if (
              line.includes("Do you want to perform these actions") ||
              line.includes("Do you really want to destroy all resources?")
            ) {
              send({ type: "REQUEST_APPROVAL" });
            }
          });
          p.onExit(({ exitCode }) => {
            send({ type: "EXITED", exitCode });
          });

          return () => {
            logger.trace("Terracorm CLI state machine: cleaning up pty");
            p.write("\x03"); // CTRL + C, pty.kill() does not work on windows
            // TODO: is there a way to delay this? maybe go into a "killing" state first?
          };
        },
      },
      on: {
        EXITED: "exited",
        STOP: "stopped",
      },
      initial: "processing",
      states: {
        // TODO: what else might TF CLI be asking? Can we detect any question from the TF CLI to show a good error?
        processing: {
          on: {
            REQUEST_APPROVAL: "awaiting_approval",
          },
        },
        awaiting_approval: {
          on: {
            APPROVED_EXTERNALLY: "processing",
            REJECTED_EXTERNALLY: {
              target: "#root.exited",
              actions: assign<
                DeployContext,
                DeployEvent & { type: "REJECTED_EXTERNALLY" }
              >({ cancelled: true }),
            },
            APPROVE: {
              target: "processing",
              actions: send(
                { type: "SEND_INPUT", input: "yes\n" },
                { to: "pty" }
              ),
            },
            REJECT: {
              target: "processing",
              actions: [
                send({ type: "SEND_INPUT", input: "no\n" }, { to: "pty" }),
                assign<DeployContext, DeployEvent & { type: "REJECT" }>({
                  cancelled: true,
                }),
              ],
            },
          },
        },
      },
    },
    exited: { type: "final" },
    stopped: { type: "final" },
  },
});

export function createAndStartDeployService(options: {
  refreshOnly?: boolean;
  parallelism: number;
  extraOptions: string[];
  terraformBinaryName: string;
  autoApprove?: boolean;
  workdir: string;
}) {
  const service = interpret(deployMachine);

  const config: PtySpawnConfig = {
    file: options.terraformBinaryName,
    args: [
      "apply",
      ...(options.autoApprove ? ["-auto-approve"] : []),
      // "-input=false", we can't use this anymore but TODO: we need to detect TF CLI asking for missing inputs and either allow passing them or stop there and fail

      ...options.extraOptions,
      ...(options.refreshOnly ? ["-refresh-only"] : []),
      ...(options.parallelism > -1
        ? [`-parallelism=${options.parallelism}`]
        : []),
    ],
    options: {
      cwd: options.workdir,
      env: process.env as { [key: string]: string }, // TODO: make this explicit and move to caller or whatever
    },
  };

  service.send({ type: "START", pty: config });

  return service;
}

export function createAndStartDestroyService(options: {
  parallelism: number;
  extraOptions: string[];
  terraformBinaryName: string;
  autoApprove?: boolean;
  workdir: string;
}) {
  const service = interpret(deployMachine);

  const config: PtySpawnConfig = {
    file: options.terraformBinaryName,
    args: [
      "destroy",
      ...(options.autoApprove ? ["-auto-approve"] : []),
      // "-input=false", we can't use this anymore but TODO: we need to detect TF CLI asking for missing inputs and either allow passing them or stop there and fail

      ...options.extraOptions,
      ...(options.parallelism > -1
        ? [`-parallelism=${options.parallelism}`]
        : []),
    ],
    options: {
      cwd: options.workdir,
      env: process.env as { [key: string]: string }, // TODO: make this explicit and move to caller or whatever
    },
  };

  service.send({ type: "START", pty: config });

  return service;
}
