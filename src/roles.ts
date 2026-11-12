// The minimum role per tool (functn-it mcp/, "What a role may do: per tool"). A tool a person's role
// doesn't reach is left out of tools/list, and a call to it is answered like any unknown tool.
// Every registered tool must be listed here: mcp.ts refuses to register one that isn't.

import type { Role } from "./access.js";

export const TOOL_ROLES: Readonly<Record<string, Role>> = {
  // Reading
  whoami: "reader",
  list_users: "reader",
  list_companies: "reader",
  list_projects: "reader",
  list_task_lists: "reader",
  get_task_list: "reader",
  list_tasks: "reader",
  get_task: "reader",
  list_subtasks: "reader",
  list_todos: "reader",
  get_todo: "reader",
  list_comments: "reader",
  get_comment: "reader",
  list_task_dependencies: "reader",
  get_task_dependency: "reader",
  list_workflow_statuses: "reader",
  list_activities: "reader",
  get_recent_updates: "reader",
  list_time_entries: "reader",
  list_services: "reader",
  list_deals: "reader",
  list_project_deals: "reader",
  list_bookings: "reader",
  list_folders: "reader",
  get_folder: "reader",
  list_pages: "reader",
  get_page: "reader",
  list_attachments: "reader",
  get_attachment: "reader",

  // Creating and changing records (nothing here deletes)
  create_task_list: "editor",
  copy_task_list: "editor",
  update_task_list: "editor",
  create_task: "editor",
  update_task: "editor",
  create_subtask: "editor",
  create_todo: "editor",
  update_todo: "editor",
  add_task_comment: "editor",
  update_comment: "editor",
  add_comment_reaction: "editor",
  create_task_dependency: "editor",
  create_time_entry: "editor",
  create_folder: "editor",
  update_folder: "editor",
  create_page: "editor",
  update_page: "editor",
  copy_page: "editor",
};
