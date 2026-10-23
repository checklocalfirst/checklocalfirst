import { supabase, supabaseAdmin } from "../dbconnect.js";

export const authMiddleware = async (req, res, next) => {
    try{
    const tokenString = req.headers.authorization;

    if(!tokenString){
        return res.status(401).json({success: false, error: 'No token provided'});
    }

    const [bearerString, token] = tokenString.split(' ');

    const {data, error} = await supabase.auth.getUser(token);

    if(error){
        return res.status(401).json({success: false, error: 'User auth failed'});
    }

    req.user = data.user;
    // Kept for routes that act on the caller's own session (e.g. POST /auth/logout).
    req.accessToken = token;
    next();
    }catch(err){
        console.log(err);
        return res.status(500).json({success: false, error: 'Something went wrong'});
    }
}

export const authAdminMiddleware = async (req, res, next) => {

    try{

    
    
    const {data, error} = await supabaseAdmin.from('users').select('account_type').eq('user_id', req.user.id).single();

    if(error){
        return res.status(500).json({success: false, error: 'Admin auth failed'});
    }

    if(data.account_type !== 'admin'){
        return res.status(403).json({success: false, error: 'Unauthorized'});
    }

    next();
    }catch(err){
        console.log(err);
        return res.status(500).json({success: false, error: 'Something went wrong'});
    }
}