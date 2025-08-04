#!/usr/bin/osascript

-- Audit tags in Things to see what sync-related tags remain
-- Returns JSON with tag analysis

tell application "Things3"
    set tag_analysis to {}
    set sync_tagged_tasks to {}
    set all_tags to {}
    
    -- Get all tasks from inbox
    set inbox_todos to to dos of list "Inbox"
    
    repeat with todo_item in inbox_todos
        if status of todo_item is open then
            set task_name to name of todo_item
            set task_id to id of todo_item
            set task_tags to tag names of todo_item
            
            -- Collect all unique tags
            repeat with tag_name in task_tags
                set tag_str to tag_name as string
                if tag_str is not in all_tags then
                    set end of all_tags to tag_str
                end if
            end repeat
            
            -- Check for sync-related tags
            set has_sync_tags to false
            set sync_tags_found to {}
            
            repeat with tag_name in task_tags
                set tag_str to tag_name as string
                if tag_str contains "synced" then
                    set has_sync_tags to true
                    set end of sync_tags_found to tag_str
                end if
            end repeat
            
            if has_sync_tags then
                set task_info to "{\"name\":\"" & task_name & "\",\"id\":\"" & task_id & "\",\"syncTags\":[" & my tagsToJson(sync_tags_found) & "],\"allTags\":[" & my tagsToJson(task_tags) & "]}"
                set end of sync_tagged_tasks to task_info
            end if
        end if
    end repeat
    
    -- Build final JSON response
    set sync_tags_only to {}
    repeat with tag_name in all_tags
        set tag_str to tag_name as string
        if tag_str contains "synced" then
            set end of sync_tags_only to tag_str
        end if
    end repeat
    
    set result_json to "{"
    set result_json to result_json & "\"totalTasks\":" & (count of inbox_todos) & ","
    set result_json to result_json & "\"tasksWithSyncTags\":" & (count of sync_tagged_tasks) & ","
    set result_json to result_json & "\"allTags\":[" & my tagsToJson(all_tags) & "],"
    set result_json to result_json & "\"syncTags\":[" & my tagsToJson(sync_tags_only) & "],"
    set result_json to result_json & "\"taggedTasks\":[" & my joinList(sync_tagged_tasks, ",") & "]"
    set result_json to result_json & "}"
    
    return result_json
end tell

-- Helper function to convert tags to JSON array
on tagsToJson(tag_list)
    set json_tags to {}
    repeat with tag_name in tag_list
        set end of json_tags to "\"" & tag_name & "\""
    end repeat
    return my joinList(json_tags, ",")
end tagsToJson

-- Helper function to join list items
on joinList(item_list, delimiter)
    set old_delimiters to AppleScript's text item delimiters
    set AppleScript's text item delimiters to delimiter
    set result_string to item_list as string
    set AppleScript's text item delimiters to old_delimiters
    return result_string
end joinList
