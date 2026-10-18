import type { Pool } from "pg";
import { LearningEngine, type LearningState, type LearningTrigger } from "./learning-engine.js";

export class LearningStore {
  constructor(private readonly pool:Pool,private readonly projectScoped=false){}
  private get stateTable(){return this.projectScoped?'agy_project_learning_state':'agy_learning_state';}
  private get auditTable(){return this.projectScoped?'agy_project_learning_audit':'agy_learning_audit';}
  async read():Promise<LearningState> {const r=await this.pool.query(`SELECT state FROM ${this.stateTable} WHERE state_id='library'`);if(!r.rowCount)throw new Error("LEARNING_MIGRATION_REQUIRED");return r.rows[0].state;}
  async transact<T>(operation:(engine:LearningEngine)=>T):Promise<T> {
    const client=await this.pool.connect();try {
      await client.query("BEGIN");const row=await client.query(`SELECT state FROM ${this.stateTable} WHERE state_id='library' FOR UPDATE`);
      if(!row.rowCount)throw new Error("LEARNING_MIGRATION_REQUIRED");
      const previous:LearningState=row.rows[0].state;const engine=new LearningEngine(()=>Date.now(),previous);
      const result=operation(engine);const next=engine.snapshot();
      for(const item of next.audit.slice(previous.audit.length))await client.query(`INSERT INTO ${this.auditTable}(sequence,actor,action,target,detail) VALUES($1,$2,$3,$4,$5)`,[item.sequence,item.actor,item.action,item.target,item.detail]);
      await client.query(`UPDATE ${this.stateTable} SET state=$1,revision=revision+1,updated_at=now() WHERE state_id='library'`,[next]);
      await client.query("COMMIT");return result;
    }catch(error){await client.query("ROLLBACK");throw error;}finally{client.release();}
  }
  async processEvents(limit=100) {
    const client=await this.pool.connect();try {
      await client.query("BEGIN");const row=await client.query(`SELECT state FROM ${this.stateTable} WHERE state_id='library' FOR UPDATE`);
      if(!row.rowCount)throw new Error("LEARNING_MIGRATION_REQUIRED");
      const prior:LearningState=row.rows[0].state;const engine=new LearningEngine(()=>Date.now(),prior);
      const events=await client.query(`SELECT * FROM agy_learning_events WHERE processed_at IS NULL ORDER BY event_id LIMIT $1 FOR UPDATE SKIP LOCKED`,[Math.max(1,Math.min(1000,limit))]);
      for(const event of events.rows){engine.trigger(event.trigger_type as LearningTrigger,event.context);const data=event.payload;
        if(event.trigger_type==='MODEL_TOOL_CHANGE'&&data.after?.model)engine.revalidate(event.context,data.after.model);
        if(data.retry_count>=2)engine.trigger("REPEATED_RETRIES",event.context);
        if(data.error_type)engine.trigger("FAILURE_PATTERN",event.context);
        if(data.metadata?.qaConflict)engine.trigger("QA_CONFLICT",event.context);
        await client.query(`UPDATE agy_learning_events SET processed_at=now() WHERE event_id=$1`,[event.event_id]);}
      const next=engine.snapshot();for(const item of next.audit.slice(prior.audit.length))await client.query(`INSERT INTO ${this.auditTable}(sequence,actor,action,target,detail) VALUES($1,$2,$3,$4,$5)`,[item.sequence,item.actor,item.action,item.target,item.detail]);
      await client.query(`UPDATE ${this.stateTable} SET state=$1,revision=revision+1,updated_at=now() WHERE state_id='library'`,[next]);await client.query("COMMIT");return{processed:events.rowCount};
    }catch(error){await client.query("ROLLBACK");throw error;}finally{client.release();}
  }
}
