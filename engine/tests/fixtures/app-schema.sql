CREATE TABLE alembic_version (version_num VARCHAR(128) NOT NULL);
CREATE TABLE project (
	id INTEGER NOT NULL, 
	title VARCHAR NOT NULL, 
	story VARCHAR, 
	style VARCHAR NOT NULL, 
	summary VARCHAR, 
	video_url VARCHAR, 
	status VARCHAR NOT NULL, 
	created_at DATETIME NOT NULL, 
	updated_at DATETIME NOT NULL, text_provider_override VARCHAR, image_provider_override VARCHAR, video_provider_override VARCHAR, target_shot_count INTEGER, character_hints JSON, creation_mode VARCHAR, reference_images JSON, exports JSON, story_outline JSON, visual_bible VARCHAR, outline_approved BOOLEAN DEFAULT 0 NOT NULL, universe_id INTEGER, chapter_number INTEGER, chapter_title VARCHAR, skill_id VARCHAR, reimagine_meta JSON, 
	PRIMARY KEY (id)
);
CREATE TABLE agentrun (
	id INTEGER NOT NULL, 
	project_id INTEGER NOT NULL, 
	status VARCHAR NOT NULL, 
	current_agent VARCHAR, 
	progress FLOAT NOT NULL, 
	route_decision TEXT, 
	patch_plan TEXT, 
	error VARCHAR, 
	resource_type VARCHAR, 
	resource_id INTEGER, 
	created_at DATETIME NOT NULL, 
	updated_at DATETIME NOT NULL, provider_snapshot JSON, thread_id VARCHAR, confirm_requested BOOLEAN DEFAULT 0 NOT NULL, awaiting_payload JSON, 
	PRIMARY KEY (id), 
	FOREIGN KEY(project_id) REFERENCES project (id)
);
CREATE INDEX ix_agentrun_project_id ON agentrun (project_id);
CREATE INDEX ix_agentrun_resource_id ON agentrun (resource_id);
CREATE INDEX ix_agentrun_resource_type ON agentrun (resource_type);
CREATE INDEX ix_agentrun_status ON agentrun (status);
CREATE TABLE agentmessage (
	id INTEGER NOT NULL, 
	run_id INTEGER NOT NULL, 
	agent VARCHAR NOT NULL, 
	role VARCHAR NOT NULL, 
	content VARCHAR NOT NULL, 
	created_at DATETIME NOT NULL, 
	PRIMARY KEY (id), 
	FOREIGN KEY(run_id) REFERENCES agentrun (id)
);
CREATE INDEX ix_agentmessage_run_id ON agentmessage (run_id);
CREATE TABLE message (
	id INTEGER NOT NULL, 
	project_id INTEGER NOT NULL, 
	run_id INTEGER, 
	agent VARCHAR NOT NULL, 
	role VARCHAR NOT NULL, 
	content VARCHAR NOT NULL, 
	progress FLOAT, 
	is_loading BOOLEAN NOT NULL, 
	created_at DATETIME NOT NULL, summary VARCHAR, 
	PRIMARY KEY (id), 
	FOREIGN KEY(project_id) REFERENCES project (id), 
	FOREIGN KEY(run_id) REFERENCES agentrun (id)
);
CREATE INDEX ix_message_project_id ON message (project_id);
CREATE INDEX ix_message_run_id ON message (run_id);
CREATE TABLE configitem (
	"key" VARCHAR(255) NOT NULL, 
	value TEXT NOT NULL, 
	description VARCHAR, 
	is_sensitive BOOLEAN NOT NULL, 
	created_at DATETIME NOT NULL, 
	updated_at DATETIME NOT NULL, 
	PRIMARY KEY ("key")
);
CREATE INDEX ix_configitem_is_sensitive ON configitem (is_sensitive);
CREATE TABLE character (
	id INTEGER NOT NULL, 
	project_id INTEGER NOT NULL, 
	name VARCHAR NOT NULL, 
	description VARCHAR, 
	image_url VARCHAR, approved_name VARCHAR, approved_description VARCHAR, approved_image_url VARCHAR, approved_at DATETIME, approval_version INTEGER DEFAULT 0 NOT NULL, reference_images JSON, face_embedding TEXT, visual_notes TEXT, 
	PRIMARY KEY (id), 
	FOREIGN KEY(project_id) REFERENCES project (id)
);
CREATE INDEX ix_character_project_id ON character (project_id);
CREATE TABLE shot (
	id INTEGER NOT NULL, 
	project_id INTEGER NOT NULL, 
	"order" INTEGER NOT NULL, 
	description VARCHAR NOT NULL, 
	prompt VARCHAR, 
	image_prompt VARCHAR, 
	image_url VARCHAR, 
	video_url VARCHAR, 
	duration FLOAT, camera VARCHAR, motion_note VARCHAR, character_ids JSON DEFAULT '[]' NOT NULL, approved_description VARCHAR, approved_prompt VARCHAR, approved_image_prompt VARCHAR, approved_duration FLOAT, approved_camera VARCHAR, approved_motion_note VARCHAR, approved_character_ids JSON DEFAULT '[]' NOT NULL, approved_at DATETIME, approval_version INTEGER DEFAULT 0 NOT NULL, scene VARCHAR, action VARCHAR, expression VARCHAR, lighting VARCHAR, dialogue VARCHAR, sfx VARCHAR, approved_scene VARCHAR, approved_action VARCHAR, approved_expression VARCHAR, approved_lighting VARCHAR, approved_dialogue VARCHAR, approved_sfx VARCHAR, seed INTEGER, tts_url VARCHAR, bgm_type VARCHAR, 
	PRIMARY KEY (id), 
	FOREIGN KEY(project_id) REFERENCES project (id)
);
CREATE INDEX ix_shot_order ON shot ("order");
CREATE INDEX ix_shot_project_id ON shot (project_id);
CREATE TABLE run (
	id INTEGER NOT NULL, 
	project_id INTEGER NOT NULL, 
	thread_id VARCHAR NOT NULL, 
	status VARCHAR NOT NULL, 
	version INTEGER NOT NULL, 
	source VARCHAR NOT NULL, 
	created_at DATETIME NOT NULL, 
	updated_at DATETIME NOT NULL, 
	PRIMARY KEY (id), 
	FOREIGN KEY(project_id) REFERENCES project (id)
);
CREATE INDEX ix_run_project_id ON run (project_id);
CREATE INDEX ix_run_status ON run (status);
CREATE UNIQUE INDEX ix_run_thread_id ON run (thread_id);
CREATE TABLE stage (
	id INTEGER NOT NULL, 
	project_id INTEGER NOT NULL, 
	run_id INTEGER NOT NULL, 
	name VARCHAR NOT NULL, 
	status VARCHAR NOT NULL, 
	version INTEGER NOT NULL, 
	source VARCHAR NOT NULL, 
	created_at DATETIME NOT NULL, 
	updated_at DATETIME NOT NULL, 
	PRIMARY KEY (id), 
	FOREIGN KEY(project_id) REFERENCES project (id), 
	FOREIGN KEY(run_id) REFERENCES run (id)
);
CREATE INDEX ix_stage_name ON stage (name);
CREATE INDEX ix_stage_project_id ON stage (project_id);
CREATE INDEX ix_stage_run_id ON stage (run_id);
CREATE INDEX ix_stage_status ON stage (status);
CREATE TABLE artifact (
	id INTEGER NOT NULL, 
	project_id INTEGER NOT NULL, 
	run_id INTEGER NOT NULL, 
	stage_id INTEGER NOT NULL, 
	name VARCHAR NOT NULL, 
	artifact_type VARCHAR NOT NULL, 
	uri VARCHAR NOT NULL, 
	version INTEGER NOT NULL, 
	source VARCHAR NOT NULL, 
	created_at DATETIME NOT NULL, 
	updated_at DATETIME NOT NULL, 
	PRIMARY KEY (id), 
	FOREIGN KEY(project_id) REFERENCES project (id), 
	FOREIGN KEY(run_id) REFERENCES run (id), 
	FOREIGN KEY(stage_id) REFERENCES stage (id)
);
CREATE INDEX ix_artifact_artifact_type ON artifact (artifact_type);
CREATE INDEX ix_artifact_name ON artifact (name);
CREATE INDEX ix_artifact_project_id ON artifact (project_id);
CREATE INDEX ix_artifact_run_id ON artifact (run_id);
CREATE INDEX ix_artifact_stage_id ON artifact (stage_id);
CREATE TABLE shot_character_binding (
	shot_id INTEGER NOT NULL, 
	character_id INTEGER NOT NULL, 
	PRIMARY KEY (shot_id, character_id), 
	FOREIGN KEY(shot_id) REFERENCES shot (id), 
	FOREIGN KEY(character_id) REFERENCES character (id)
);
CREATE INDEX ix_shot_character_binding_shot_id ON shot_character_binding (shot_id);
CREATE INDEX ix_shot_character_binding_character_id ON shot_character_binding (character_id);
CREATE TABLE asset (
	id INTEGER NOT NULL, 
	name VARCHAR NOT NULL, 
	asset_type VARCHAR NOT NULL, 
	description VARCHAR, 
	image_url VARCHAR, 
	metadata_json VARCHAR, 
	source_project_id INTEGER, 
	tags VARCHAR, 
	created_at DATETIME NOT NULL, 
	updated_at DATETIME NOT NULL, 
	PRIMARY KEY (id), 
	FOREIGN KEY(source_project_id) REFERENCES project (id)
);
CREATE INDEX ix_asset_asset_type ON asset (asset_type);
CREATE INDEX ix_asset_name ON asset (name);
CREATE INDEX ix_agentrun_thread_id ON agentrun (thread_id);
CREATE TABLE style_template (
	id INTEGER NOT NULL, 
	name VARCHAR NOT NULL, 
	slug VARCHAR NOT NULL, 
	category VARCHAR DEFAULT 'custom' NOT NULL, 
	description VARCHAR, 
	style_prompt VARCHAR NOT NULL, 
	color_palette JSON, 
	negative_prompt VARCHAR, 
	preview_image_url VARCHAR, 
	sort_order INTEGER DEFAULT '0' NOT NULL, 
	is_active BOOLEAN DEFAULT true NOT NULL, 
	created_at DATETIME NOT NULL, 
	updated_at DATETIME NOT NULL, 
	PRIMARY KEY (id)
);
CREATE INDEX ix_style_template_name ON style_template (name);
CREATE INDEX ix_style_template_category ON style_template (category);
CREATE UNIQUE INDEX ix_style_template_slug ON style_template (slug);
CREATE TABLE artifactversion (
	id INTEGER NOT NULL, 
	project_id INTEGER NOT NULL, 
	entity_type VARCHAR NOT NULL, 
	entity_id INTEGER NOT NULL, 
	version INTEGER NOT NULL, 
	snapshot JSON NOT NULL, 
	run_id INTEGER, 
	"trigger" VARCHAR NOT NULL, 
	created_at DATETIME NOT NULL, 
	PRIMARY KEY (id), 
	FOREIGN KEY(project_id) REFERENCES project (id), 
	FOREIGN KEY(run_id) REFERENCES agentrun (id)
);
CREATE INDEX ix_artifactversion_project_id ON artifactversion (project_id);
CREATE INDEX ix_artifactversion_entity_type ON artifactversion (entity_type);
CREATE INDEX ix_artifactversion_entity_id ON artifactversion (entity_id);
CREATE INDEX ix_artifactversion_run_id ON artifactversion (run_id);
CREATE TABLE consistency_report (
	id INTEGER NOT NULL, 
	project_id INTEGER NOT NULL, 
	run_id INTEGER, 
	report_data JSON NOT NULL, 
	overall_score FLOAT DEFAULT '0.0' NOT NULL, 
	created_at DATETIME NOT NULL, 
	PRIMARY KEY (id), 
	FOREIGN KEY(project_id) REFERENCES project (id), 
	FOREIGN KEY(run_id) REFERENCES agentrun (id)
);
CREATE INDEX ix_consistency_report_project_id ON consistency_report (project_id);
CREATE TABLE universe (
	id INTEGER NOT NULL, 
	name VARCHAR NOT NULL, 
	description VARCHAR, 
	world_setting TEXT, 
	style_rules TEXT, 
	cover_image_url VARCHAR, 
	is_active BOOLEAN DEFAULT true NOT NULL, 
	created_at DATETIME NOT NULL, 
	updated_at DATETIME NOT NULL, 
	PRIMARY KEY (id)
);
CREATE INDEX ix_universe_name ON universe (name);
CREATE TABLE sharedcharacter (
	id INTEGER NOT NULL, 
	universe_id INTEGER NOT NULL, 
	name VARCHAR NOT NULL, 
	description VARCHAR, 
	visual_notes TEXT, 
	reference_images JSON DEFAULT '[]' NOT NULL, 
	face_embedding TEXT, 
	canonical_image_url VARCHAR, 
	character_tags VARCHAR, 
	source_project_id INTEGER, 
	source_character_id INTEGER, 
	version INTEGER DEFAULT '1' NOT NULL, 
	is_active BOOLEAN DEFAULT true NOT NULL, 
	created_at DATETIME NOT NULL, 
	updated_at DATETIME NOT NULL, 
	PRIMARY KEY (id), 
	FOREIGN KEY(universe_id) REFERENCES universe (id), 
	FOREIGN KEY(source_project_id) REFERENCES project (id)
);
CREATE INDEX ix_sharedcharacter_universe_id ON sharedcharacter (universe_id);
CREATE TABLE universeprojectlink (
	id INTEGER NOT NULL, 
	universe_id INTEGER NOT NULL, 
	project_id INTEGER NOT NULL, 
	chapter_number INTEGER, 
	chapter_title VARCHAR, 
	is_main_story BOOLEAN DEFAULT true NOT NULL, 
	created_at DATETIME NOT NULL, 
	PRIMARY KEY (id), 
	FOREIGN KEY(universe_id) REFERENCES universe (id), 
	FOREIGN KEY(project_id) REFERENCES project (id)
);
CREATE INDEX ix_universeprojectlink_project_id ON universeprojectlink (project_id);
CREATE INDEX ix_universeprojectlink_universe_id ON universeprojectlink (universe_id);
CREATE INDEX ix_project_skill_id ON project (skill_id);
CREATE TABLE exportcache (
	export_id VARCHAR(64) NOT NULL, 
	payload TEXT NOT NULL, 
	expires_at DATETIME NOT NULL, 
	created_at DATETIME NOT NULL, 
	PRIMARY KEY (export_id)
);
CREATE INDEX ix_exportcache_expires_at ON exportcache (expires_at);
CREATE TABLE checkpoints (
                    thread_id TEXT NOT NULL,
                    checkpoint_ns TEXT NOT NULL DEFAULT '',
                    checkpoint_id TEXT NOT NULL,
                    parent_checkpoint_id TEXT,
                    type TEXT,
                    checkpoint BLOB,
                    metadata BLOB,
                    PRIMARY KEY (thread_id, checkpoint_ns, checkpoint_id)
                );
CREATE TABLE writes (
                    thread_id TEXT NOT NULL,
                    checkpoint_ns TEXT NOT NULL DEFAULT '',
                    checkpoint_id TEXT NOT NULL,
                    task_id TEXT NOT NULL,
                    idx INTEGER NOT NULL,
                    channel TEXT NOT NULL,
                    type TEXT,
                    value BLOB,
                    PRIMARY KEY (thread_id, checkpoint_ns, checkpoint_id, task_id, idx)
                );
