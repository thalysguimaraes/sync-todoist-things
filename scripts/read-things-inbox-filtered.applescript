#!/usr/bin/osascript

-- Read tasks from Things inbox with filtering support
-- Returns only tasks that match filter criteria and don't have sync tags
-- Usage: osascript read-things-inbox-filtered.applescript [enabled_projects] [enabled_tags] [excluded_tags]

on run argv
    set json_output to "["
    set first_item to true
    
    -- Parse filter arguments
    set enabled_projects to ""
    set enabled_tags to ""
    set excluded_tags to "synced-from-todoist,synced-to-todoist"
    
    if (count of argv) > 0 then
        set enabled_projects to item 1 of argv
    end if
    
    if (count of argv) > 1 then
        set enabled_tags to item 2 of argv
    end if
    
    if (count of argv) > 2 then
        set excluded_tags to item 3 of argv
    end if
    
    -- Convert comma-separated strings to lists
    set enabled_project_list to my split_string(enabled_projects, ",")
    set enabled_tag_list to my split_string(enabled_tags, ",")
    set excluded_tag_list to my split_string(excluded_tags, ",")
    
    tell application "Things3"
        -- Get all todos from the Inbox
        set inbox_todos to to dos of list "Inbox"
        
        repeat with todo_item in inbox_todos
            -- Check if task should be included based on filters
            if my should_include_task(todo_item, enabled_project_list, enabled_tag_list, excluded_tag_list) then
                -- Skip completed or cancelled tasks
                if status of todo_item is open then
                    -- Build JSON object
                    if not first_item then
                        set json_output to json_output & ","
                    end if
                    set first_item to false
                    
                    -- Get task properties
                    set todo_name to name of todo_item
                    set todo_name to my escape_quotes(todo_name)
                    
                    set todo_notes to notes of todo_item
                    if todo_notes is missing value then
                        set todo_notes to ""
                    else
                        set todo_notes to my escape_quotes(todo_notes)
                    end if
                    
                    -- Get project/area if exists
                    set todo_project to ""
                    try
                        set parent_project to project of todo_item
                        if parent_project is not missing value then
                            set todo_project to name of parent_project
                        end if
                    on error
                        try
                            set parent_area to area of todo_item
                            if parent_area is not missing value then
                                set todo_project to name of parent_area
                            end if
                        on error
                            set todo_project to ""
                        end try
                    end try
                    
                    -- Get due date if exists
                    set todo_due to due date of todo_item
                    if todo_due is missing value then
                        set due_string to "null"
                    else
                        set due_string to "\"" & my format_date(todo_due) & "\""
                    end if
                    
                    -- Get tags
                    set todo_tags to tag names of todo_item
                    
                    -- Build JSON
                    set json_output to json_output & "{" & ¬
                        "\"id\":\"" & (id of todo_item) & "\"," & ¬
                        "\"title\":\"" & todo_name & "\"," & ¬
                        "\"notes\":\"" & todo_notes & "\"," & ¬
                        "\"project\":\"" & todo_project & "\"," & ¬
                        "\"due\":" & due_string & "," & ¬
                        "\"tags\":[" & my get_tags_json(todo_tags, excluded_tag_list) & "]" & ¬
                        "}"
                end if
            end if
        end repeat
    end tell
    
    set json_output to json_output & "]"
    return json_output
end run

-- Check if task should be included based on filters
on should_include_task(todo_item, enabled_projects, enabled_tags, excluded_tags)
    tell application "Things3"
        -- Check excluded tags first
        set todo_tags to tag names of todo_item
        repeat with excluded_tag in excluded_tags
            if excluded_tag is in todo_tags then
                return false
            end if
        end repeat
        
        -- Check project filter
        if (count of enabled_projects) > 0 and (item 1 of enabled_projects) is not "" then
            set task_project to ""
            try
                set parent_project to project of todo_item
                if parent_project is not missing value then
                    set task_project to name of parent_project
                end if
            on error
                try
                    set parent_area to area of todo_item
                    if parent_area is not missing value then
                        set task_project to name of parent_area
                    end if
                on error
                    set task_project to ""
                end try
            end try
            
            if task_project is "" then
                return false -- No project, but filter requires one
            end if
            
            set project_matched to false
            repeat with enabled_project in enabled_projects
                if task_project is enabled_project then
                    set project_matched to true
                    exit repeat
                end if
            end repeat
            
            if not project_matched then
                return false
            end if
        end if
        
        -- Check tag filter (at least one enabled tag must be present)
        if (count of enabled_tags) > 0 and (item 1 of enabled_tags) is not "" then
            set tag_matched to false
            repeat with enabled_tag in enabled_tags
                if enabled_tag is in todo_tags then
                    set tag_matched to true
                    exit repeat
                end if
            end repeat
            
            if not tag_matched then
                return false
            end if
        end if
        
        return true
    end tell
end should_include_task

-- Helper function to split string by delimiter
on split_string(the_string, the_delimiter)
    set old_delimiters to AppleScript's text item delimiters
    set AppleScript's text item delimiters to the_delimiter
    set the_list to text items of the_string
    set AppleScript's text item delimiters to old_delimiters
    return the_list
end split_string

-- Helper function to escape quotes
on escape_quotes(input_string)
    set escaped_string to input_string
    
    -- Escape backslashes first
    set AppleScript's text item delimiters to "\\"
    set string_parts to text items of escaped_string
    set AppleScript's text item delimiters to "\\\\"
    set escaped_string to string_parts as string
    
    -- Escape quotes
    set AppleScript's text item delimiters to "\""
    set string_parts to text items of escaped_string
    set AppleScript's text item delimiters to "\\\""
    set escaped_string to string_parts as string
    
    -- Escape newlines
    set AppleScript's text item delimiters to return
    set string_parts to text items of escaped_string
    set AppleScript's text item delimiters to "\\n"
    set escaped_string to string_parts as string
    
    set AppleScript's text item delimiters to linefeed
    set string_parts to text items of escaped_string
    set AppleScript's text item delimiters to "\\n"
    set escaped_string to string_parts as string
    
    -- Escape tabs
    set AppleScript's text item delimiters to tab
    set string_parts to text items of escaped_string
    set AppleScript's text item delimiters to "\\t"
    set escaped_string to string_parts as string
    
    set AppleScript's text item delimiters to ""
    
    return escaped_string
end escape_quotes

-- Helper function to format date as ISO 8601
on format_date(the_date)
    set {year:y, month:m, day:d} to the_date
    set month_num to m as integer
    if month_num < 10 then set month_num to "0" & month_num
    if d < 10 then set d to "0" & d
    return (y as string) & "-" & month_num & "-" & d
end format_date

-- Helper function to convert tags to JSON array (excluding certain tags)
on get_tags_json(tag_list, excluded_tags)
    set json_tags to ""
    set first_tag to true
    
    repeat with tag_name in tag_list
        set should_include to true
        repeat with excluded_tag in excluded_tags
            if tag_name is excluded_tag then
                set should_include to false
                exit repeat
            end if
        end repeat
        
        if should_include then
            if not first_tag then
                set json_tags to json_tags & ","
            end if
            set first_tag to false
            set json_tags to json_tags & "\"" & tag_name & "\""
        end if
    end repeat
    
    return json_tags
end get_tags_json