#!/usr/bin/osascript

-- Debug how Things returns tag information

tell application "Things3"
    -- Get first task from inbox
    set inbox_todos to to dos of list "Inbox"
    
    if (count of inbox_todos) > 0 then
        set first_task to item 1 of inbox_todos
        set task_name to name of first_task
        
        -- Try different ways to get tags
        try
            set tag_names_result to tag names of first_task
            set tag_names_class to class of tag_names_result
            set tag_names_count to count of tag_names_result
            
            set output_text to "Task: " & task_name & return
            set output_text to output_text & "Tag names class: " & (tag_names_class as string) & return
            set output_text to output_text & "Tag names count: " & tag_names_count & return
            set output_text to output_text & "Tag names result: " & (tag_names_result as string) & return
            
            -- Try to get tags directly
            try
                set tags_result to tags of first_task
                set tags_class to class of tags_result
                set tags_count to count of tags_result
                
                set output_text to output_text & return & "Tags class: " & (tags_class as string) & return
                set output_text to output_text & "Tags count: " & tags_count & return
                
                if tags_count > 0 then
                    repeat with i from 1 to tags_count
                        set current_tag to item i of tags_result
                        set tag_name to name of current_tag
                        set output_text to output_text & "Tag " & i & ": " & tag_name & return
                    end repeat
                end if
                
            on error tags_error
                set output_text to output_text & "Tags error: " & tags_error & return
            end try
            
        on error tag_names_error
            set output_text to output_text & "Tag names error: " & tag_names_error & return
        end try
        
        return output_text
        
    else
        return "No tasks found in inbox"
    end if
end tell
