#!/usr/bin/osascript

-- Read recently completed tasks from Things that were synced to Todoist
-- Returns JSON array of completed tasks with their IDs and completion timestamps

on run
    set json_output to "["
    set first_item to true
    
    -- Calculate date 24 hours ago
    set yesterday to (current date) - (1 * days)
    
    tell application "Things3"
        -- Get all completed todos from Logbook
        set completed_todos to to dos of list "Logbook"
        
        repeat with todo_item in completed_todos
            -- Check if task has the synced-to-todoist tag
            set todo_tags to tag names of todo_item
            if "synced-to-todoist" is in todo_tags then
                -- Check if completed within last 24 hours
                set completion_date to completion date of todo_item
                if completion_date is not missing value and completion_date > yesterday then
                    -- Build JSON object
                    if not first_item then
                        set json_output to json_output & ","
                    end if
                    set first_item to false
                    
                    -- Format completion date as ISO 8601
                    set completion_string to my format_datetime(completion_date)
                    
                    -- Build JSON
                    set json_output to json_output & "{" & ¬
                        "\"thingsId\":\"" & (id of todo_item) & "\"," & ¬
                        "\"completedAt\":\"" & completion_string & "\"" & ¬
                        "}"
                end if
            end if
        end repeat
    end tell
    
    set json_output to json_output & "]"
    return json_output
end run

-- Helper function to format datetime as ISO 8601
on format_datetime(the_date)
    set {year:y, month:m, day:d, hours:h, minutes:min, seconds:s} to the_date
    
    -- Format month
    set month_num to m as integer
    if month_num < 10 then set month_num to "0" & month_num
    
    -- Format day
    if d < 10 then set d to "0" & d
    
    -- Format hours
    if h < 10 then set h to "0" & h
    
    -- Format minutes
    if min < 10 then set min to "0" & min
    
    -- Format seconds
    if s < 10 then set s to "0" & s
    
    -- Build ISO 8601 datetime string
    return (y as string) & "-" & month_num & "-" & d & "T" & h & ":" & min & ":" & s & "Z"
end format_datetime