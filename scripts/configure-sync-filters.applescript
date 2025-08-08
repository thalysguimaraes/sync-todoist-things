#!/usr/bin/osascript

-- Configure sync filters for selective project/tag synchronization
-- Usage: osascript configure-sync-filters.applescript "project1,project2" "tag1,tag2" "exclude_tag1,exclude_tag2"

on run argv
    set config_result to "{\"status\":\"error\",\"message\":\"No arguments provided\"}"
    
    -- Parse arguments
    if (count of argv) > 0 then
        set enabled_projects to item 1 of argv
    else
        set enabled_projects to ""
    end if
    
    if (count of argv) > 1 then
        set enabled_tags to item 2 of argv
    else
        set enabled_tags to ""
    end if
    
    if (count of argv) > 2 then
        set excluded_tags to item 3 of argv
    else
        set excluded_tags to "synced-from-todoist,synced-to-todoist"
    end if
    
    -- Store configuration in Things as a special note
    tell application "Things3"
        try
            -- Look for existing config note
            set config_notes to to dos whose name is "[SYNC-CONFIG]"
            
            if (count of config_notes) > 0 then
                -- Update existing config
                set config_note to item 1 of config_notes
                set notes of config_note to "Sync Configuration" & return & ¬
                    "Updated: " & (current date as string) & return & ¬
                    "---" & return & ¬
                    "Enabled Projects: " & enabled_projects & return & ¬
                    "Enabled Tags: " & enabled_tags & return & ¬
                    "Excluded Tags: " & excluded_tags
            else
                -- Create new config note
                set new_config to make new to do with properties {name:"[SYNC-CONFIG]", notes:"Sync Configuration" & return & ¬
                    "Updated: " & (current date as string) & return & ¬
                    "---" & return & ¬
                    "Enabled Projects: " & enabled_projects & return & ¬
                    "Enabled Tags: " & enabled_tags & return & ¬
                    "Excluded Tags: " & excluded_tags}
                
                -- Move to Someday list to keep it out of the way
                move new_config to list "Someday"
            end if
            
            set config_result to "{" & ¬
                "\"status\":\"success\"," & ¬
                "\"enabled_projects\":\"" & enabled_projects & "\"," & ¬
                "\"enabled_tags\":\"" & enabled_tags & "\"," & ¬
                "\"excluded_tags\":\"" & excluded_tags & "\"" & ¬
                "}"
            
        on error err_msg
            set config_result to "{\"status\":\"error\",\"message\":\"" & err_msg & "\"}"
        end try
    end tell
    
    return config_result
end run

-- Helper function to get current configuration
on get_config()
    tell application "Things3"
        try
            set config_notes to to dos whose name is "[SYNC-CONFIG]"
            
            if (count of config_notes) > 0 then
                set config_note to item 1 of config_notes
                set config_text to notes of config_note
                
                -- Parse configuration from notes
                set enabled_projects to ""
                set enabled_tags to ""
                set excluded_tags to "synced-from-todoist,synced-to-todoist"
                
                set text_lines to paragraphs of config_text
                repeat with line_text in text_lines
                    if line_text starts with "Enabled Projects: " then
                        set enabled_projects to text 19 thru -1 of line_text
                    else if line_text starts with "Enabled Tags: " then
                        set enabled_tags to text 15 thru -1 of line_text
                    else if line_text starts with "Excluded Tags: " then
                        set excluded_tags to text 16 thru -1 of line_text
                    end if
                end repeat
                
                return {enabled_projects:enabled_projects, enabled_tags:enabled_tags, excluded_tags:excluded_tags}
            else
                return {enabled_projects:"", enabled_tags:"", excluded_tags:"synced-from-todoist,synced-to-todoist"}
            end if
            
        on error
            return {enabled_projects:"", enabled_tags:"", excluded_tags:"synced-from-todoist,synced-to-todoist"}
        end try
    end tell
end get_config