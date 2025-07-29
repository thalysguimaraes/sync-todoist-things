#!/usr/bin/osascript

-- Read tasks from Things inbox and output as JSON
-- Returns only tasks that don't have the tags "synced-from-todoist" or "synced-to-todoist"

on run
    set json_output to "["
    set first_item to true
    
    tell application "Things3"
        -- Get all todos from the Inbox
        set inbox_todos to to dos of list "Inbox"
        
        repeat with todo_item in inbox_todos
            -- Skip if already synced (either direction)
            set todo_tags to tag names of todo_item
            if "synced-from-todoist" is not in todo_tags and "synced-to-todoist" is not in todo_tags then
                -- Skip completed or cancelled tasks
                if status of todo_item is open then
                    -- Build JSON object
                    if not first_item then
                        set json_output to json_output & ","
                    end if
                    set first_item to false
                    
                    -- Escape quotes in text fields
                    set todo_name to name of todo_item
                    set todo_name to my escape_quotes(todo_name)
                    
                    set todo_notes to notes of todo_item
                    if todo_notes is missing value then
                        set todo_notes to ""
                    else
                        set todo_notes to my escape_quotes(todo_notes)
                    end if
                    
                    -- Get due date if exists
                    set todo_due to due date of todo_item
                    if todo_due is missing value then
                        set due_string to "null"
                    else
                        set due_string to "\"" & my format_date(todo_due) & "\""
                    end if
                    
                    -- Build JSON
                    set json_output to json_output & "{" & ¬
                        "\"id\":\"" & (id of todo_item) & "\"," & ¬
                        "\"title\":\"" & todo_name & "\"," & ¬
                        "\"notes\":\"" & todo_notes & "\"," & ¬
                        "\"due\":" & due_string & "," & ¬
                        "\"tags\":[" & my get_tags_json(todo_tags) & "]" & ¬
                        "}"
                end if
            end if
        end repeat
    end tell
    
    set json_output to json_output & "]"
    return json_output
end run

-- Helper function to escape quotes
on escape_quotes(input_string)
    set AppleScript's text item delimiters to "\""
    set string_parts to text items of input_string
    set AppleScript's text item delimiters to "\\\""
    set escaped_string to string_parts as string
    set AppleScript's text item delimiters to ""
    
    -- Also escape newlines
    set AppleScript's text item delimiters to return
    set string_parts to text items of escaped_string
    set AppleScript's text item delimiters to "\\n"
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

-- Helper function to convert tags to JSON array
on get_tags_json(tag_list)
    set json_tags to ""
    set first_tag to true
    
    repeat with tag_name in tag_list
        if tag_name is not "synced-from-todoist" and tag_name is not "synced-to-todoist" then
            if not first_tag then
                set json_tags to json_tags & ","
            end if
            set first_tag to false
            set json_tags to json_tags & "\"" & tag_name & "\""
        end if
    end repeat
    
    return json_tags
end get_tags_json